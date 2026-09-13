/**
 * Uniswap V3 venue on Ethereum Sepolia.
 *
 *   holdings  balanceOf(wallet) for every token in the universe
 *   prices    from each route's pools' slot0 -- the same pools we trade in,
 *             so valuation and execution can never disagree
 *   history   reconstructed from the pools' Swap events, bucketed by block,
 *             so volatility is measured on real on-chain trades
 *   quotes    QuoterV2.quoteExactInput over the route, via eth_call
 *   execute   SwapRouter02.exactInput, signed inside the enclave
 *
 * CRE allows 15 HTTP calls per execution. This venue uses five: one batched
 * snapshot (pool tokens, spot prices, balances, block), one for history logs,
 * one for quotes, one for gas + nonce, one to broadcast a single multicall.
 *
 * Every number is bigint. sqrtPriceX96 arithmetic is done at full width and
 * reduced once at the end.
 */

import { type Address, type Hex, concatHex, decodeFunctionResult, encodeFunctionData, numberToHex, padHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { BPS_DENOMINATOR, E8_SCALE } from "./numeric";
import { type Rpc, type RpcRequest, callRequest, hexToBigint, requireHex, rpcBatch, rpcCall } from "./rpc";
import type { ExecutableTrade, Holding, PlannedTrade, Quote, Venue } from "./venue";

export type UniswapConfig = {
  chain_id: number;
  router: Address;
  quoter: Address;
  /** Token id (lowercase address) everything is priced in. Its route is empty. */
  quote_token: string;
  tokens: Record<string, { symbol: string; decimals: number; route: { pool: Address; fee: number }[] }>;
  /** Blocks per history period. ~12s blocks on Sepolia: 100 ~= 20 minutes. */
  history_period_blocks: number;
  /** Tolerance applied to the quoted output before it becomes amountOutMinimum. */
  slippage_bps: number;
  gas_limit: string;
};

const Q192 = 2n ** 192n;
const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const POOL_ABI = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [
    { type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" },
  ] },
] as const;
const QUOTER_ABI = [
  { type: "function", name: "quoteExactInput", stateMutability: "nonpayable", inputs: [{ name: "path", type: "bytes" }, { name: "amountIn", type: "uint256" }], outputs: [
    { type: "uint256" }, { type: "uint160[]" }, { type: "uint32[]" }, { type: "uint256" },
  ] },
] as const;
const ROUTER_ABI = [
  { type: "function", name: "exactInput", stateMutability: "payable", inputs: [{ name: "params", type: "tuple", components: [
    { name: "path", type: "bytes" }, { name: "recipient", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" },
  ] }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ type: "bytes[]" }] },
] as const;

type Hop = { pool: Address; fee: number; tokenIn: string; tokenOut: string; token0: string };
type Snapshot = {
  pools: Map<Address, { token0: string; token1: string; sqrtPriceX96: bigint }>;
  balances: Map<string, bigint>;
  latestBlock: bigint;
};

/**
 * Price of `tokenIn` in `tokenOut` for one pool, at 1e8, from sqrtPriceX96.
 * P = sqrtP^2 / 2^192 is token1-per-token0 in raw units; convert to human
 * units and invert when tokenIn is token1.
 */
const hopPriceE8 = (sqrtPriceX96: bigint, hop: Hop, decIn: number, decOut: number): bigint => {
  const num = sqrtPriceX96 * sqrtPriceX96;
  return hop.tokenIn === hop.token0
    ? (num * 10n ** BigInt(decIn) * E8_SCALE) / (Q192 * 10n ** BigInt(decOut))
    : (Q192 * 10n ** BigInt(decIn) * E8_SCALE) / (num * 10n ** BigInt(decOut));
};

export const uniswapVenue = (rpc: Rpc, config: UniswapConfig, privateKey: Hex): Venue => {
  const signer = privateKeyToAccount(privateKey);
  const quoteId = config.quote_token.toLowerCase();
  const tokenIds = Object.keys(config.tokens);
  const token = (id: string) => {
    const entry = config.tokens[id];
    if (entry === undefined) throw new Error("token not in venue config");
    return entry;
  };
  const allPools = [...new Set(tokenIds.flatMap((id) => token(id).route.map((r) => r.pool)))];

  // ---- one batched read for everything the decision needs -----------------
  let snapshot: Snapshot | null = null;
  const snap = (): Snapshot => {
    if (snapshot) return snapshot;
    const requests: RpcRequest[] = [];
    for (const pool of allPools) {
      requests.push(callRequest(pool, encodeFunctionData({ abi: POOL_ABI, functionName: "token0" })));
      requests.push(callRequest(pool, encodeFunctionData({ abi: POOL_ABI, functionName: "token1" })));
      requests.push(callRequest(pool, encodeFunctionData({ abi: POOL_ABI, functionName: "slot0" })));
    }
    for (const id of tokenIds) {
      requests.push(callRequest(id as Address, encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [signer.address] })));
    }
    requests.push({ method: "eth_blockNumber", params: [] });
    const results = rpcBatch(rpc, requests);

    const pools = new Map<Address, { token0: string; token1: string; sqrtPriceX96: bigint }>();
    let cursor = 0;
    for (const pool of allPools) {
      const token0 = decodeFunctionResult({ abi: POOL_ABI, functionName: "token0", data: requireHex(results[cursor++], "token0") }).toLowerCase();
      const token1 = decodeFunctionResult({ abi: POOL_ABI, functionName: "token1", data: requireHex(results[cursor++], "token1") }).toLowerCase();
      const sqrtPriceX96 = decodeFunctionResult({ abi: POOL_ABI, functionName: "slot0", data: requireHex(results[cursor++], "slot0") })[0];
      pools.set(pool, { token0, token1, sqrtPriceX96 });
    }
    const balances = new Map<string, bigint>();
    for (const id of tokenIds) {
      balances.set(id, decodeFunctionResult({ abi: ERC20_ABI, functionName: "balanceOf", data: requireHex(results[cursor++], "balanceOf") }));
    }
    snapshot = { pools, balances, latestBlock: hexToBigint(results[cursor]) };
    return snapshot;
  };

  const hopsFor = (tokenId: string): Hop[] => {
    const hops: Hop[] = [];
    let current = tokenId;
    for (const step of token(tokenId).route) {
      const meta = snap().pools.get(step.pool);
      if (!meta) throw new Error("route pool missing from snapshot");
      if (current !== meta.token0 && current !== meta.token1) throw new Error("route pool does not contain the current token");
      const tokenOut = current === meta.token0 ? meta.token1 : meta.token0;
      token(tokenOut);
      hops.push({ pool: step.pool, fee: step.fee, tokenIn: current, tokenOut, token0: meta.token0 });
      current = tokenOut;
    }
    if (tokenId !== quoteId && current !== quoteId) throw new Error("route does not end at the quote token");
    return hops;
  };

  const routePriceE8 = (hops: Hop[], sqrtOf: (pool: Address) => bigint): bigint => {
    let price = E8_SCALE;
    for (const hop of hops) {
      price = (price * hopPriceE8(sqrtOf(hop.pool), hop, token(hop.tokenIn).decimals, token(hop.tokenOut).decimals)) / E8_SCALE;
    }
    return price;
  };
  const spotPriceE8 = (tokenId: string): bigint =>
    tokenId === quoteId ? E8_SCALE : routePriceE8(hopsFor(tokenId), (pool) => snap().pools.get(pool)!.sqrtPriceX96);

  const encodePath = (hops: Hop[]): Hex => {
    const parts: Hex[] = [hops[0].tokenIn as Hex];
    for (const hop of hops) parts.push(padHex(numberToHex(hop.fee), { size: 3 }), hop.tokenOut as Hex);
    return concatHex(parts);
  };
  const tradeHops = (trade: PlannedTrade): Hop[] => {
    const forward = hopsFor(trade.tokenId);
    return trade.side === "sell" ? forward : [...forward].reverse().map((h) => ({ ...h, tokenIn: h.tokenOut, tokenOut: h.tokenIn }));
  };
  /** Input amount in the input token's base units for a USD notional; a sell never exceeds the balance. */
  const amountInFor = (trade: PlannedTrade): bigint => {
    if (trade.side === "buy") return (trade.notionalUsdE8 * 10n ** BigInt(token(quoteId).decimals)) / E8_SCALE;
    const wanted = (trade.notionalUsdE8 * 10n ** BigInt(token(trade.tokenId).decimals)) / spotPriceE8(trade.tokenId);
    const held = snap().balances.get(trade.tokenId) ?? 0n;
    return wanted < held ? wanted : held;
  };

  return {
    holdings: (universe) =>
      universe.map((id): Holding => ({ tokenId: id, symbol: token(id).symbol, rawBalance: snap().balances.get(id) ?? 0n, decimals: token(id).decimals })),

    prices: (universe) => new Map(universe.map((id) => [id, spotPriceE8(id)])),

    history: (universe, periods) => {
      const latest = snap().latestBlock;
      const span = BigInt(periods) * BigInt(config.history_period_blocks);
      const from = latest > span ? latest - span : 0n;
      const fromHex = `0x${from.toString(16)}`;
      // One batch: Swap logs for every pool over the window.
      const results = rpcBatch(rpc, allPools.map((pool) => ({
        method: "eth_getLogs", params: [{ address: pool, topics: [SWAP_TOPIC], fromBlock: fromHex, toBlock: "latest" }],
      })));
      const poolSeries = new Map<Address, bigint[]>();
      allPools.forEach((pool, index) => {
        const logs = Array.isArray(results[index]) ? (results[index] as Record<string, unknown>[]) : [];
        const buckets: (bigint | null)[] = new Array(periods).fill(null);
        for (const log of logs) {
          const block = hexToBigint(log.blockNumber);
          const i = Number((block - from) / BigInt(config.history_period_blocks));
          if (i < 0 || i >= periods) continue;
          // Swap data words: amount0, amount1, sqrtPriceX96, liquidity, tick.
          buckets[i] = BigInt(`0x${String(log.data).slice(2 + 64 * 2, 2 + 64 * 3)}`);
        }
        let last = buckets.find((b) => b !== null) ?? snap().pools.get(pool)!.sqrtPriceX96;
        poolSeries.set(pool, buckets.map((b) => { if (b !== null) last = b; return last; }));
      });
      const out = new Map<string, bigint[]>();
      for (const id of universe) {
        if (id === quoteId) { out.set(id, new Array(periods).fill(E8_SCALE)); continue; }
        const hops = hopsFor(id);
        out.set(id, Array.from({ length: periods }, (_, i) => routePriceE8(hops, (pool) => poolSeries.get(pool)![i])));
      }
      return out;
    },

    quotes: (trades): Quote[] => {
      const prepared = trades.map((trade) => ({ trade, hops: tradeHops(trade), amountIn: amountInFor(trade) }));
      const results = rpcBatch(rpc, prepared.map(({ hops, amountIn }) =>
        callRequest(config.quoter, encodeFunctionData({ abi: QUOTER_ABI, functionName: "quoteExactInput", args: [encodePath(hops), amountIn] })),
      ));
      return prepared.map(({ trade, hops, amountIn }, index) => {
        const [amountOut] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInput", data: requireHex(results[index], "quote") });
        // What spot would have given for this exact input, in output base units.
        const inDec = BigInt(token(hops[0].tokenIn).decimals);
        const outDec = BigInt(token(hops[hops.length - 1].tokenOut).decimals);
        const priceIn = spotPriceE8(hops[0].tokenIn);   // in quote
        const priceOut = spotPriceE8(hops[hops.length - 1].tokenOut);
        const spotOut = (amountIn * priceIn * 10n ** outDec) / (priceOut * 10n ** inDec);
        const impactBps = spotOut > amountOut ? ((spotOut - amountOut) * BPS_DENOMINATOR) / spotOut : 0n;
        return { amountOut, impactBps };
      });
    },

    execute: async (trades: ExecutableTrade[]) => {
      const [gasPriceHex, nonceHex] = rpcBatch(rpc, [
        { method: "eth_gasPrice", params: [] },
        { method: "eth_getTransactionCount", params: [signer.address, "pending"] },
      ]);
      // Every leg in ONE transaction via the router's multicall: sells fund
      // buys atomically, there is a single nonce, and a partial rebalance is
      // impossible -- either the whole plan lands or none of it does.
      const calls = trades.map((trade) => {
        const minOut = (trade.minAmountOut * (BPS_DENOMINATOR - BigInt(config.slippage_bps))) / BPS_DENOMINATOR;
        return encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInput", args: [{
          path: encodePath(tradeHops(trade)), recipient: signer.address, amountIn: amountInFor(trade), amountOutMinimum: minOut,
        }] });
      });
      const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "multicall", args: [calls] });
      const signed = await signer.signTransaction({
        chainId: config.chain_id, to: config.router, data,
        gas: BigInt(config.gas_limit) * BigInt(trades.length), gasPrice: hexToBigint(gasPriceHex),
        nonce: Number(hexToBigint(nonceHex)), value: 0n,
      });
      return String(rpcCall(rpc, "eth_sendRawTransaction", [signed]));
    },
  };
};

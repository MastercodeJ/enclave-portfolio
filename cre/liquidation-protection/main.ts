/**
 * Automated liquidation protection -- Chainlink CRE Confidential Workflow.
 *
 * Protects a vETH-collateral / vUSD-debt position on ChallengeLending. The
 * protection policy (policy.ts) and the wallet key are Vault DON secrets,
 * decrypted only inside a Nitro enclave. The position is read, the decision
 * made, and the transaction signed all inside the enclave; only the signed
 * transaction leaves it.
 *
 * Triggers, all feeding the same decision:
 *   - EVM log: ChallengeStarted  -> place the pre-emptive buffer
 *   - EVM log: PriceUpdate       -> re-evaluate before the admin's checkAllHF()
 *   - cron                       -> backstop in case a log is missed
 *
 * Logging discipline: every runtime.log line is visible outside the enclave.
 * Nothing derived from the policy -- no hf, threshold, amount or price -- is
 * ever logged. Only coarse status words and transaction hashes, which are
 * public the moment they are broadcast anyway.
 */

import {
  CronCapability,
  EVMClient,
  HTTPClient,
  NITRO_REGIONS,
  Runner,
  handlerInTee,
  type TeeConstraint,
  type TeeRuntime,
  type Workflow,
} from "@chainlink/cre-sdk";
import { type Address, type Hex, decodeFunctionResult, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { asObject } from "../confidential-rebalancer/numeric";
import { type Action, type Decision, decide, parsePolicy } from "./policy";

// ---------------------------------------------------------------------------
// Config (public) and secrets (private)
// ---------------------------------------------------------------------------

export type Config = {
  /** Cron backstop. Public by necessity: the trigger runs on the DON. */
  schedule: string;
  chain_name: "ethereum-testnet-sepolia";
  rpc_url: string;
  lending_address: Address;
  veth_address: Address;
  vusd_address: Address;
  /** Gas limit for deposit()/repay(). */
  gas_limit: string;
  secrets_ids: {
    private_key_id: string;
    policy_id: string;
  };
};

const SEPOLIA_CHAIN_ID = 11155111;
const JSON_HEADERS = { "Content-Type": "application/json" };

/** keccak256 of the event signatures, as the log trigger topic0 values. */
const TOPIC_CHALLENGE_STARTED = "0xa895da4b794aeba8d8082db237265459db7b7ffdb5aa7c2332a7c5eafbfae735";
const TOPIC_PRICE_UPDATE = "0x92664190cca12aca9cd5309d87194bdda75bb51362d71c06e1a6f75c7c765711";
const TOPIC_DEPOSIT = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";
const TOPIC_REPAY = "0x5c16de4f8b59bd9caf0f49a545f25819a895ed223294290b408242e72a594231";

/** How far back to look for our own Deposit/Repay when computing the cooldown. */
const COOLDOWN_LOOKBACK_BLOCKS = 2_000n;

// ---------------------------------------------------------------------------
// ABI fragments
// ---------------------------------------------------------------------------

const LENDING_ABI = [
  {
    type: "function", name: "getUserPosition", stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "tuple", components: [
      { name: "collateral", type: "uint256" }, { name: "debt", type: "uint256" }, { name: "hf", type: "uint256" },
      { name: "numOperations", type: "uint256" }, { name: "lastUpdateTime", type: "uint256" }, { name: "cumulativeDebtTime", type: "uint256" },
    ] }],
  },
  { type: "function", name: "vETHPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "start_Debt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "scenarioStartTime", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "scenarioEndTime", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "challengeOpen", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "repay", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
] as const;

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

// ---------------------------------------------------------------------------
// JSON-RPC over confidential HTTP
// ---------------------------------------------------------------------------

type Rpc = {
  runtime: TeeRuntime<Config>;
  client: HTTPClient;
  url: string;
  nextId: number;
};

const rpcCall = (rpc: Rpc, method: string, params: unknown[]): unknown => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: rpc.nextId++, method, params });
  const response = rpc.client
    .sendRequest(rpc.runtime, {
      url: rpc.url,
      method: "POST",
      body: Buffer.from(new TextEncoder().encode(body)).toString("base64"),
      headers: JSON_HEADERS,
    })
    .result();
  const raw = new TextDecoder().decode(response.body);
  if (response.statusCode >= 400) {
    throw new Error(`rpc ${method} http ${response.statusCode}`);
  }
  const json = asObject(JSON.parse(raw));
  if (json.error !== undefined) {
    // RPC error text can echo calldata. Keep only the method name.
    throw new Error(`rpc ${method} failed`);
  }
  return json.result;
};

const hexToBigint = (value: unknown): bigint => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error("rpc returned a non-hex quantity");
  }
  return BigInt(value);
};

const ethCall = (rpc: Rpc, to: Address, data: Hex): Hex => {
  const result = rpcCall(rpc, "eth_call", [{ to, data }, "latest"]);
  if (typeof result !== "string") throw new Error("eth_call returned no data");
  return result as Hex;
};

const readLending = {
  challengeOpen: (rpc: Rpc, to: Address): boolean =>
    decodeFunctionResult({ abi: LENDING_ABI, functionName: "challengeOpen", data: ethCall(rpc, to, encodeFunctionData({ abi: LENDING_ABI, functionName: "challengeOpen" })) }),
  scenarioStartTime: (rpc: Rpc, to: Address): bigint =>
    decodeFunctionResult({ abi: LENDING_ABI, functionName: "scenarioStartTime", data: ethCall(rpc, to, encodeFunctionData({ abi: LENDING_ABI, functionName: "scenarioStartTime" })) }),
  scenarioEndTime: (rpc: Rpc, to: Address): bigint =>
    decodeFunctionResult({ abi: LENDING_ABI, functionName: "scenarioEndTime", data: ethCall(rpc, to, encodeFunctionData({ abi: LENDING_ABI, functionName: "scenarioEndTime" })) }),
  vETHPrice: (rpc: Rpc, to: Address): bigint =>
    decodeFunctionResult({ abi: LENDING_ABI, functionName: "vETHPrice", data: ethCall(rpc, to, encodeFunctionData({ abi: LENDING_ABI, functionName: "vETHPrice" })) }),
  startDebt: (rpc: Rpc, to: Address): bigint =>
    decodeFunctionResult({ abi: LENDING_ABI, functionName: "start_Debt", data: ethCall(rpc, to, encodeFunctionData({ abi: LENDING_ABI, functionName: "start_Debt" })) }),
  position: (rpc: Rpc, to: Address, user: Address) =>
    decodeFunctionResult({ abi: LENDING_ABI, functionName: "getUserPosition", data: ethCall(rpc, to, encodeFunctionData({ abi: LENDING_ABI, functionName: "getUserPosition", args: [user] })) }),
};

const readBalance = (rpc: Rpc, token: Address, owner: Address): bigint =>
  decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: "balanceOf",
    data: ethCall(rpc, token, encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [owner] })),
  });

/** Latest block number and timestamp. */
const readLatestBlock = (rpc: Rpc): { number: bigint; timestamp: bigint } => {
  const block = asObject(rpcCall(rpc, "eth_getBlockByNumber", ["latest", false]));
  return { number: hexToBigint(block.number), timestamp: hexToBigint(block.timestamp) };
};

/**
 * Timestamp of our most recent Deposit or Repay, or 0n.
 *
 * Fails open: any error here yields 0n, which disables the cooldown for this
 * cycle. The cooldown only ever suppresses a non-critical top-up, so failing
 * toward acting is the safe direction.
 */
const readLastActionAt = (rpc: Rpc, lending: Address, user: Address, latest: bigint): bigint => {
  try {
    const from = latest > COOLDOWN_LOOKBACK_BLOCKS ? latest - COOLDOWN_LOOKBACK_BLOCKS : 0n;
    const userTopic = `0x${user.slice(2).toLowerCase().padStart(64, "0")}`;
    const logs = rpcCall(rpc, "eth_getLogs", [
      { address: lending, fromBlock: `0x${from.toString(16)}`, toBlock: "latest", topics: [[TOPIC_DEPOSIT, TOPIC_REPAY], userTopic] },
    ]);
    if (!Array.isArray(logs) || logs.length === 0) return 0n;
    let newest = 0n;
    for (const entry of logs) {
      const blockNumber = hexToBigint(asObject(entry).blockNumber);
      if (blockNumber > newest) newest = blockNumber;
    }
    const block = asObject(rpcCall(rpc, "eth_getBlockByNumber", [`0x${newest.toString(16)}`, false]));
    return hexToBigint(block.timestamp);
  } catch {
    return 0n;
  }
};

// ---------------------------------------------------------------------------
// Transactions, signed inside the enclave
// ---------------------------------------------------------------------------

type Signer = ReturnType<typeof privateKeyToAccount>;

const sendAction = async (
  rpc: Rpc,
  signer: Signer,
  lending: Address,
  action: Action,
  nonce: number,
  gasPrice: bigint,
  gasLimit: bigint,
): Promise<string> => {
  const data = encodeFunctionData({ abi: LENDING_ABI, functionName: action.kind, args: [action.units] });
  // Legacy (type 0) transaction: the simplest shape every Sepolia RPC accepts,
  // and one fewer fee parameter to get wrong under time pressure.
  const signed = await signer.signTransaction({
    chainId: SEPOLIA_CHAIN_ID,
    to: lending,
    data,
    gas: gasLimit,
    gasPrice,
    nonce,
    value: 0n,
  });
  const hash = rpcCall(rpc, "eth_sendRawTransaction", [signed]);
  if (typeof hash !== "string") throw new Error("eth_sendRawTransaction returned no hash");
  return hash;
};

/**
 * viem wants a 0x-prefixed 32-byte hex key; cast and most wallets export it
 * either way. Normalise without ever echoing the value.
 */
const normalizePrivateKey = (raw: string): Hex => {
  const trimmed = raw.trim();
  const hex = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("private key secret is not a 32-byte hex string");
  }
  return `0x${hex}`;
};

// ---------------------------------------------------------------------------
// The protection cycle
// ---------------------------------------------------------------------------

export const protect = async (runtime: TeeRuntime<Config>): Promise<string> => {
  const config = runtime.config;

  const secrets = runtime
    .getSecrets([{ id: config.secrets_ids.private_key_id }, { id: config.secrets_ids.policy_id }])
    .result();
  const policy = parsePolicy(secrets[config.secrets_ids.policy_id].value);
  const signer = privateKeyToAccount(normalizePrivateKey(secrets[config.secrets_ids.private_key_id].value));

  const rpc: Rpc = { runtime, client: new HTTPClient(), url: config.rpc_url, nextId: 1 };
  const lending = config.lending_address;

  // The contract only accepts deposit()/repay() while open AND started.
  // Acting outside that window would just burn gas on reverts.
  const open = readLending.challengeOpen(rpc, lending);
  const startedAt = readLending.scenarioStartTime(rpc, lending);
  const endedAt = readLending.scenarioEndTime(rpc, lending);
  if (!open || startedAt === 0n || endedAt !== 0n) {
    runtime.log("held reason=inactive");
    return "HELD";
  }

  const position = readLending.position(rpc, lending, signer.address);
  const price = readLending.vETHPrice(rpc, lending);
  const originalDebt = readLending.startDebt(rpc, lending);
  const freeVeth = readBalance(rpc, config.veth_address, signer.address);
  const freeVusd = readBalance(rpc, config.vusd_address, signer.address);
  const latest = readLatestBlock(rpc);
  const lastActionAt = readLastActionAt(rpc, lending, signer.address, latest.number);

  const decision: Decision = decide(
    policy,
    { collateral: position.collateral, debt: position.debt },
    { price, freeVeth, freeVusd, originalDebt, lastActionAt, now: latest.timestamp },
  );

  if (decision.actions.length === 0) {
    runtime.log(`held reason=${decision.reason}`);
    return "HELD";
  }

  const gasPrice = hexToBigint(rpcCall(rpc, "eth_gasPrice", []));
  let nonce = Number(hexToBigint(rpcCall(rpc, "eth_getTransactionCount", [signer.address, "pending"])));
  const hashes: string[] = [];
  for (const action of decision.actions) {
    const hash = await sendAction(rpc, signer, lending, action, nonce++, gasPrice, BigInt(config.gas_limit));
    hashes.push(hash);
    runtime.log(`acted kind=${action.kind} tx=${hash}`);
  }
  return JSON.stringify({ status: "ACTED", reason: decision.reason, txs: hashes });
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const initWorkflow = (config: Config): Workflow<Config> => {
  for (const key of ["schedule", "rpc_url", "lending_address", "veth_address", "vusd_address", "gas_limit"] as const) {
    if (!config[key]) throw new Error(`config requires ${key}`);
  }
  if (!config.secrets_ids?.private_key_id || !config.secrets_ids?.policy_id) {
    throw new Error("config requires secrets_ids.private_key_id and secrets_ids.policy_id");
  }

  const evm = new EVMClient(EVMClient.SUPPORTED_CHAIN_SELECTORS[config.chain_name]);
  const tee: TeeConstraint = [{ tee: "nitro", regions: [NITRO_REGIONS[0]] }];

  return [
    // 0: react the moment the scenario starts or the price moves.
    handlerInTee(
      evm.logTrigger({
        addresses: [config.lending_address],
        topics: [{ values: [TOPIC_CHALLENGE_STARTED, TOPIC_PRICE_UPDATE] }],
        confidence: "CONFIDENCE_LEVEL_LATEST",
      }),
      protect,
      tee,
    ),
    // 1: backstop. The decision is idempotent, so a redundant tick is a no-op.
    handlerInTee(new CronCapability().trigger({ schedule: config.schedule }), protect, tee),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}

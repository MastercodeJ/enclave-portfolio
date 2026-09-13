/**
 * Development tool: replay one rebalance cycle against Uniswap V3 on Sepolia
 * outside the enclave, printing every stage, and DRY-RUN the swaps with
 * eth_call so a would-be revert shows its reason instead of costing gas.
 *
 * Never point this at production secrets: it prints the strategy in clear.
 *
 *   bun run trace:sepolia            # dry run
 *   bun run trace:sepolia --send     # actually broadcast
 */
import { buildTrades, computeAllocations, valueHoldings } from "./main";
import { composeTargets, parsePortfolioSpec, requiredHistoryPeriods } from "./portfolio";
import type { Rpc } from "./rpc";
import { type UniswapConfig, uniswapVenue } from "./uniswap";

const config = (await Bun.file("config.sepolia.json").json()) as { rpc_url: string; uniswap: UniswapConfig };
const spec = parsePortfolioSpec(process.env.REBALANCER_PORTFOLIO_SPEC_SEPOLIA!);
const key = (() => { const k = process.env.CRE_ETH_PRIVATE_KEY!.trim(); return (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`; })();
const send = process.argv.includes("--send");

// Synchronous HTTP via curl, because the venue's RPC helper is synchronous
// (it mirrors CRE's blocking capability API).
const client = {
  sendRequest: (_runtime: unknown, request: { url: string; method: string; body?: string; headers?: Record<string, string> }) => ({
    result: () => {
      const body = request.body ? Buffer.from(request.body, "base64").toString() : "";
      const proc = Bun.spawnSync(["curl", "-s", "-X", request.method, "-H", "content-type: application/json", "--data-binary", body, request.url]);
      const text = new TextDecoder().decode(proc.stdout);
      // Dev tool only: surface RPC error text the enclave helper deliberately hides.
      if (text.includes('"error"')) console.error("  rpc error:", text.slice(0, 400));
      return { statusCode: proc.exitCode === 0 ? 200 : 500, body: new Uint8Array(proc.stdout) };
    },
  }),
};
// biome-ignore lint/suspicious/noExplicitAny: dev shim
const rpc: Rpc = { runtime: {} as any, client: client as any, url: config.rpc_url, nextId: 1 };
const venue = uniswapVenue(rpc, config.uniswap, key);
const sym = (id: string) => config.uniswap.tokens[id]?.symbol ?? id;
const usd = (e8: bigint) => `$${(Number(e8) / 1e8).toFixed(2)}`;
const pct = (bps: bigint) => `${(Number(bps) / 100).toFixed(2)}%`;
const rule = (t: string) => console.log(`\n${"─".repeat(72)}\n${t}\n${"─".repeat(72)}`);

rule("1. WALLET  (real balances on Sepolia)");
const holdings = venue.holdings(spec.universe);
const prices = venue.prices(spec.universe);
for (const h of holdings) console.log(`  ${sym(h.tokenId).padEnd(6)} ${(Number(h.rawBalance) / 10 ** h.decimals).toFixed(6).padStart(14)}  @ ${usd(prices.get(h.tokenId)!)}`);

rule("2. HISTORY  (from pool Swap events)");
const periods = requiredHistoryPeriods(spec);
const history = periods > 0 ? venue.history(spec.universe, periods) : new Map<string, bigint[]>();
for (const [id, series] of history) console.log(`  ${sym(id).padEnd(6)} ${series.length} periods  first ${usd(series[0])}  last ${usd(series[series.length - 1])}`);

rule("3. TARGETS  (secret)");
const targets = composeTargets(spec, { universe: spec.universe, baseWeightsBps: spec.baseWeightsBps, history, pricesE8: prices });
for (const [id, t] of targets) console.log(`  ${sym(id).padEnd(6)} ${pct(spec.baseWeightsBps.get(id) ?? 0n).padStart(7)} -> ${pct(t).padStart(7)}`);

rule("4. DRIFT AND SIZING  (secret)");
const valued = valueHoldings(holdings, prices);
const { allocations, totalUsdE8, maxDriftBps } = computeAllocations(valued, targets);
console.log(`  book ${usd(totalUsdE8)}   max drift ${pct(maxDriftBps)} vs band ${pct(spec.policy.driftThresholdBps)}`);
const planned = buildTrades(allocations, spec.policy.maxTradeBps, totalUsdE8, spec.quote);
for (const t of planned) console.log(`  ${t.side.toUpperCase().padEnd(4)} ${sym(t.tokenId).padEnd(6)} ${usd(t.notionalUsdE8)}`);

rule("5. QUOTES  (QuoterV2, real reserves)");
const quotes = venue.quotes(planned, spec.quote);
const executable = planned.flatMap((t, i) => {
  const q = quotes[i]; const ok = q.impactBps <= spec.policy.maxPriceImpactBps;
  console.log(`  ${sym(t.tokenId).padEnd(6)} out=${q.amountOut}  impact ${pct(q.impactBps)} vs cap ${pct(spec.policy.maxPriceImpactBps)} -> ${ok ? "keep" : "DROP"}`);
  return ok ? [{ ...t, minAmountOut: q.amountOut, destinationTokenId: t.side === "buy" ? t.tokenId : spec.quote }] : [];
});

rule(send ? "6. EXECUTE  (signed locally, broadcast)" : "6. NOT SENT  (pass --send to broadcast)");
if (send) console.log("  " + (await venue.execute(executable, "wallet")));

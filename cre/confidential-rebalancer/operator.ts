/**
 * Operator view: a LOCAL-ONLY server that computes what the enclave would
 * compute -- composed targets, drift, planned trades -- from the spec in
 * cre/.env, for the dashboard's "reveal" toggle.
 *
 * Binds to 127.0.0.1 and nothing else. It exists so the owner of the secret
 * can see their own strategy next to the public view; it is not part of the
 * deployed system and must never be exposed beyond this machine.
 *
 *   bun run operator          # http://127.0.0.1:8790/operator
 */
import { buildTrades, computeAllocations, valueHoldings } from "./main";
import { composeTargets, parsePortfolioSpec, requiredHistoryPeriods } from "./portfolio";
import type { Rpc } from "./rpc";
import { type UniswapConfig, uniswapVenue } from "./uniswap";

const config = (await Bun.file("config.sepolia.json").json()) as { rpc_url: string; uniswap: UniswapConfig };
const key = (() => { const k = process.env.CRE_ETH_PRIVATE_KEY!.trim(); return (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`; })();

const client = {
  sendRequest: (_r: unknown, request: { url: string; method: string; body?: string }) => ({
    result: () => {
      const body = request.body ? Buffer.from(request.body, "base64").toString() : "";
      const proc = Bun.spawnSync(["curl", "-s", "-X", request.method, "-H", "content-type: application/json", "--data-binary", body, request.url]);
      return { statusCode: proc.exitCode === 0 ? 200 : 500, body: new Uint8Array(proc.stdout) };
    },
  }),
};

const compute = () => {
  const spec = parsePortfolioSpec(process.env.REBALANCER_PORTFOLIO_SPEC_SEPOLIA!);
  // biome-ignore lint/suspicious/noExplicitAny: dev shim
  const rpc: Rpc = { runtime: {} as any, client: client as any, url: config.rpc_url, nextId: 1 };
  const venue = uniswapVenue(rpc, config.uniswap, key);
  const sym = (id: string) => config.uniswap.tokens[id]?.symbol ?? id;
  const holdings = venue.holdings(spec.universe);
  const prices = venue.prices(spec.universe);
  const periods = requiredHistoryPeriods(spec);
  const history = periods > 0 ? venue.history(spec.universe, periods) : new Map<string, bigint[]>();
  const targets = composeTargets(spec, { universe: spec.universe, baseWeightsBps: spec.baseWeightsBps, history, pricesE8: prices });
  const { allocations, totalUsdE8, maxDriftBps } = computeAllocations(valueHoldings(holdings, prices), targets);
  const planned = buildTrades(allocations, spec.policy.maxTradeBps, totalUsdE8, spec.quote);
  return {
    computedAt: new Date().toISOString(),
    signals: spec.signals.map((s) => ({ type: s.type, strengthBps: Number(s.strengthBps), params: s.params })),
    policy: { driftThresholdBps: Number(spec.policy.driftThresholdBps), maxTradeBps: Number(spec.policy.maxTradeBps), maxPriceImpactBps: Number(spec.policy.maxPriceImpactBps) },
    rows: allocations.map((a) => ({
      symbol: sym(a.tokenId), baseBps: Number(spec.baseWeightsBps.get(a.tokenId) ?? 0n), targetBps: Number(a.targetWeightBps),
      currentBps: Number(a.currentWeightBps), driftBps: Number(a.driftBps), deltaUsd: Number(a.deltaUsdE8) / 1e8,
      minBps: Number(spec.constraints.minBps.get(a.tokenId) ?? 0n), maxBps: Number(spec.constraints.maxBps.get(a.tokenId) ?? 10000n),
    })),
    maxDriftBps: Number(maxDriftBps),
    wouldAct: maxDriftBps >= spec.policy.driftThresholdBps && planned.length > 0,
    planned: planned.map((t) => ({ side: t.side, symbol: sym(t.tokenId), notionalUsd: Number(t.notionalUsdE8) / 1e8 })),
  };
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 8790,
  fetch(request) {
    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "http://localhost:5173" };
    if (new URL(request.url).pathname !== "/operator") return new Response("not found", { status: 404 });
    try {
      return new Response(JSON.stringify(compute()), { headers });
    } catch (error) {
      return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), { status: 500, headers });
    }
  },
});
console.log(`operator view (local only): http://127.0.0.1:${server.port}/operator`);

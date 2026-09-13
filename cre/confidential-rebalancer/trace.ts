/**
 * Development tool: replays one rebalance cycle outside the enclave and prints
 * every intermediate value.
 *
 * The enclave itself cannot show you this -- that is the point of it, and
 * runtime.log deliberately carries none of it. So this runs the exact same
 * pure functions against the exact same service, purely so a human can see
 * what the workflow decided and why.
 *
 * Never point this at production secrets: it prints the strategy in clear.
 *
 *   bun trace.ts
 */

import {
  buildTrades,
  computeAllocations,
  parseDecimalToScaled,
  parseHoldings,
  parsePrices,
  valueHoldings,
} from "./main";
import { composeTargets, parsePortfolioSpec, requiredHistoryPeriods } from "./portfolio";
import { parsePriceHistory } from "./signal";

const BASE_URL = process.env.TRACE_BASE_URL ?? "http://127.0.0.1:8787";
const ACCOUNT = process.env.TRACE_ACCOUNT ?? "0.0.1027";

const usd = (e8: bigint): string => {
  const negative = e8 < 0n;
  const magnitude = negative ? -e8 : e8;
  const whole = magnitude / 100_000_000n;
  const cents = (magnitude % 100_000_000n) / 1_000_000n;
  return `${negative ? "-" : ""}$${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
};

const pct = (bps: bigint): string => `${(Number(bps) / 100).toFixed(2)}%`;

const rule = (title: string) => {
  console.log(`\n${"─".repeat(72)}`);
  console.log(title);
  console.log("─".repeat(72));
};

// biome-ignore lint/suspicious/noExplicitAny: untyped mock payloads
const get = async (path: string): Promise<any> => {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { "x-api-key": process.env.REBALANCER_PORTFOLIO_API_KEY ?? "mock-portfolio-key" },
  });
  if (!response.ok) {
    throw new Error(`GET ${path} -> ${response.status}`);
  }
  return response.json();
};

// --- 1. the secrets --------------------------------------------------------

rule("1. THE SPEC  (in production: decrypted by the Vault DON inside the enclave)");

const spec = parsePortfolioSpec(process.env.REBALANCER_PORTFOLIO_SPEC!);
const QUOTE_TOKEN = spec.quote;

console.log(`  universe          ${spec.universe.join(", ")}`);
console.log(`  quote             ${spec.quote}`);
for (const [tokenId, weight] of spec.baseWeightsBps) {
  console.log(`  base weight       ${tokenId.padEnd(14)} ${pct(weight)}`);
}
if (spec.signals.length === 0) {
  console.log("  signals           none (static base weights)");
}
for (const signal of spec.signals) {
  console.log(
    `  signal            ${signal.type.padEnd(20)} strength ${pct(signal.strengthBps)}  ${JSON.stringify(signal.params)}`,
  );
}
for (const tokenId of spec.universe) {
  console.log(
    `  bounds            ${tokenId.padEnd(14)} ${pct(spec.constraints.minBps.get(tokenId)!)} .. ${pct(spec.constraints.maxBps.get(tokenId)!)}`,
  );
}
console.log(`  drift threshold   ${pct(spec.policy.driftThresholdBps)}`);
console.log(`  max trade         ${pct(spec.policy.maxTradeBps)} of book`);
console.log(`  max price impact  ${pct(spec.policy.maxPriceImpactBps)}`);

// --- 2. public inputs ------------------------------------------------------

rule("2. PUBLIC INPUTS  (fetched over confidential HTTP)");

const portfolioResponse = await get(`/portfolio/${ACCOUNT}`);
const holdings = parseHoldings(portfolioResponse.holdings);

const pricesResponse = await get("/prices");
const prices = parsePrices(pricesResponse.prices);

const periods = requiredHistoryPeriods(spec);
const history =
  periods > 0
    ? parsePriceHistory((await get(`/history?periods=${periods}`)).history, parseDecimalToScaled)
    : new Map<string, bigint[]>();

for (const holding of holdings) {
  const amount = Number(holding.rawBalance) / 10 ** holding.decimals;
  const price = Number(prices.get(holding.tokenId) ?? 0n) / 1e8;
  console.log(
    `  ${holding.symbol.padEnd(6)} ${amount.toLocaleString("en-US").padStart(12)} @ $${price}`,
  );
}
console.log(`  price history     ${periods} periods per token`);

// --- 3. the signal ---------------------------------------------------------

rule("3. SIGNALS  (secret: nothing below leaves the enclave)");

const targets = composeTargets(spec, {
  universe: spec.universe,
  baseWeightsBps: spec.baseWeightsBps,
  history,
  pricesE8: prices,
});

console.log("  base -> composed target:");
for (const [tokenId, target] of targets) {
  const base = spec.baseWeightsBps.get(tokenId) ?? 0n;
  const arrow = target > base ? "up  " : target < base ? "down" : "same";
  console.log(
    `    ${tokenId.padEnd(14)} ${pct(base).padStart(7)} -> ${pct(target).padStart(7)}  ${arrow}`,
  );
}

// --- 4. valuation and drift ------------------------------------------------

rule("4. VALUATION AND DRIFT  (secret)");

const valued = valueHoldings(holdings, prices);
const { allocations, totalUsdE8, maxDriftBps } = computeAllocations(valued, targets);

console.log(`  book value  ${usd(totalUsdE8)}\n`);
console.log("    token          value        now      target     drift     delta");
for (const allocation of allocations) {
  console.log(
    `    ${allocation.symbol.padEnd(6)} ${usd(allocation.valueUsdE8).padStart(12)}` +
      ` ${pct(allocation.currentWeightBps).padStart(9)}` +
      ` ${pct(allocation.targetWeightBps).padStart(9)}` +
      ` ${pct(allocation.driftBps).padStart(9)}` +
      ` ${usd(allocation.deltaUsdE8).padStart(11)}`,
  );
}

console.log(
  `\n  max drift ${pct(maxDriftBps)} vs threshold ${pct(spec.policy.driftThresholdBps)} -> ` +
    (maxDriftBps < spec.policy.driftThresholdBps ? "NOOP, within band" : "REBALANCE"),
);

// --- 5. sizing -------------------------------------------------------------

rule("5. TRADE SIZING  (secret)");

const capE8 = (spec.policy.maxTradeBps * totalUsdE8) / 10_000n;
console.log(`  per-trade cap ${pct(spec.policy.maxTradeBps)} of book = ${usd(capE8)}\n`);

const planned = buildTrades(allocations, spec.policy.maxTradeBps, totalUsdE8, QUOTE_TOKEN);
for (const trade of planned) {
  const allocation = allocations.find((a) => a.tokenId === trade.tokenId)!;
  const wanted = allocation.deltaUsdE8 < 0n ? -allocation.deltaUsdE8 : allocation.deltaUsdE8;
  const capped = wanted > capE8;
  console.log(
    `    ${trade.side.toUpperCase().padEnd(4)} ${trade.symbol.padEnd(6)}` +
      ` ${usd(trade.notionalUsdE8).padStart(11)}` +
      (capped ? `   (wanted ${usd(wanted)}, CAPPED)` : ""),
  );
}
console.log(`\n  ${QUOTE_TOKEN} excluded: it is the quote token, a residual of the other legs`);

// --- 6. impact check -------------------------------------------------------

rule("6. PRICE-IMPACT CHECK  (secret threshold, enforced in-enclave)");

const executable: { symbol: string; side: string; notional: bigint; minOut: bigint }[] = [];
for (const trade of planned) {
  const source = trade.side === "buy" ? QUOTE_TOKEN : trade.tokenId;
  const destination = trade.side === "buy" ? trade.tokenId : QUOTE_TOKEN;
  const response = await fetch(`${BASE_URL}/quote`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.REBALANCER_PORTFOLIO_API_KEY ?? "mock-portfolio-key",
    },
    body: JSON.stringify({
      token_in: source,
      token_out: destination,
      notional_usd_e8: trade.notionalUsdE8.toString(),
    }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: untyped mock payload
  const quote: any = await response.json();
  const impactBps = BigInt(quote.price_impact_bps);
  const passed = impactBps <= spec.policy.maxPriceImpactBps;
  console.log(
    `    ${trade.symbol.padEnd(6)} impact ${pct(impactBps).padStart(7)}` +
      ` vs cap ${pct(spec.policy.maxPriceImpactBps)}  ->  ${passed ? "keep" : "DROP"}`,
  );
  if (passed) {
    executable.push({
      symbol: trade.symbol,
      side: trade.side,
      notional: trade.notionalUsdE8,
      minOut: BigInt(quote.amount_out),
    });
  }
}

// --- 7. what crosses the boundary -----------------------------------------

rule("7. WHAT LEAVES THE ENCLAVE  (this, and only this, becomes public)");

for (const trade of executable) {
  console.log(
    `    ${trade.side.toUpperCase().padEnd(4)} ${trade.symbol.padEnd(6)}` +
      ` ${usd(trade.notional).padStart(11)}  min_out=${trade.minOut}`,
  );
}

console.log("\n  Not emitted: the spec, the composed targets, drift, caps, signal");
console.log("  parameters, weight bounds, or the impact threshold.\n");

import { describe, expect, test } from "bun:test";

import { parseDecimalToScaled } from "./numeric";
import { composeTargets, parsePortfolioSpec, requiredHistoryPeriods } from "./portfolio";
import { MIN_HISTORY_PERIODS, MIN_VOLATILITY_E8 } from "./signal";
import { knownSignalTypes } from "./signals";
import type { SignalContext } from "./signals";

const e8 = (value: string): bigint => parseDecimalToScaled(value, 8, "test");

const WETH = "WETH";
const WBTC = "WBTC";
const LINK = "LINK";
const USDC = "USDC";

const sum = (weights: Map<string, bigint>): bigint =>
  [...weights.values()].reduce((total, value) => total + value, 0n);

/** A valid spec, with fields overridable per test. */
const specJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    universe: [WETH, WBTC, LINK, USDC],
    quote: USDC,
    base: { [WETH]: 4000, [WBTC]: 3000, [LINK]: 1000, [USDC]: 2000 },
    signals: [],
    constraints: { min_weight: 500, max_weight: 6000 },
    policy: { drift_threshold: 500, max_trade: 2000, max_price_impact: 100 },
    ...overrides,
  });

/**
 * Deterministic price histories with distinct character:
 *   WETH  steady climb, moderate vol
 *   WBTC  choppy, high vol, flat overall
 *   LINK  steady decline, moderate vol
 *   USDC  flat
 */
const series = (start: number, stepPct: number, wobblePct: number, count: number): bigint[] => {
  const out: bigint[] = [];
  let price = start;
  for (let index = 0; index < count; index++) {
    const wobble = index % 2 === 0 ? wobblePct : -wobblePct;
    price = price * (1 + stepPct / 100) * (1 + wobble / 100);
    out.push(e8(price.toFixed(8)));
  }
  return out;
};

const HISTORY = new Map<string, bigint[]>([
  [WETH, series(2000, 1, 2, 30)],
  [WBTC, series(60000, 0, 6, 30)],
  [LINK, series(15, -1, 2, 30)],
  [USDC, series(1, 0, 0.01, 30)],
]);

const PRICES = new Map<string, bigint>(
  [...HISTORY.entries()].map(([tokenId, prices]) => [tokenId, prices[prices.length - 1]]),
);

const ctxFor = (specText: string): { spec: ReturnType<typeof parsePortfolioSpec>; ctx: SignalContext } => {
  const spec = parsePortfolioSpec(specText);
  return {
    spec,
    ctx: { universe: spec.universe, baseWeightsBps: spec.baseWeightsBps, history: HISTORY, pricesE8: PRICES },
  };
};

// ---------------------------------------------------------------------------

describe("parsePortfolioSpec", () => {
  test("parses a valid spec", () => {
    const spec = parsePortfolioSpec(specJson());
    expect(spec.universe).toEqual([LINK, USDC, WBTC, WETH]); // sorted
    expect(spec.quote).toBe(USDC);
    expect(spec.baseWeightsBps.get(WETH)).toBe(4000n);
    expect(spec.policy.driftThresholdBps).toBe(500n);
  });

  test("a universe member with no base weight holds zero strategically", () => {
    const spec = parsePortfolioSpec(specJson({ base: { [WETH]: 5000, [USDC]: 5000 } }));
    expect(spec.baseWeightsBps.get(WBTC)).toBe(0n);
    expect(spec.baseWeightsBps.get(LINK)).toBe(0n);
  });

  test("rejects malformed or empty JSON", () => {
    expect(() => parsePortfolioSpec("{not json")).toThrow(/valid JSON/);
    expect(() => parsePortfolioSpec("{}")).toThrow(/empty/);
  });

  test("rejects a quote outside the universe", () => {
    expect(() => parsePortfolioSpec(specJson({ quote: "DAI" }))).toThrow(/spec.quote/);
  });

  test("rejects a base weight for an asset outside the universe", () => {
    expect(() =>
      parsePortfolioSpec(specJson({ base: { [WETH]: 5000, DAI: 5000 } })),
    ).toThrow(/not in spec.universe/);
  });

  test("rejects base weights that do not sum to 100%", () => {
    // 33/33/33 is a real error, not something to silently rescale.
    expect(() =>
      parsePortfolioSpec(specJson({ base: { [WETH]: 3300, [WBTC]: 3300, [USDC]: 3300 } })),
    ).toThrow(/sum to exactly/);
  });

  test("rejects a fractional bps value as ambiguous", () => {
    expect(() =>
      parsePortfolioSpec(specJson({ base: { [WETH]: 50.5, [USDC]: 9949.5 } })),
    ).toThrow(/integer/);
  });

  test("rejects duplicate universe entries", () => {
    expect(() => parsePortfolioSpec(specJson({ universe: [WETH, WETH, USDC] }))).toThrow(/duplicates/);
  });

  test("rejects an unknown signal type and names the known ones", () => {
    expect(() =>
      parsePortfolioSpec(specJson({ signals: [{ type: "astrology", strength: 5000 }] })),
    ).toThrow(/unknown signal type "astrology".*inverse_volatility/);
  });

  test("rejects signal strengths summing past 100%", () => {
    expect(() =>
      parsePortfolioSpec(
        specJson({
          signals: [
            { type: "inverse_volatility", strength: 6000, lookback: 20 },
            { type: "momentum", strength: 5000, lookback: 10 },
          ],
        }),
      ),
    ).toThrow(/must not exceed/);
  });

  test("rejects a block's bad params through the block's own validator", () => {
    expect(() =>
      parsePortfolioSpec(specJson({ signals: [{ type: "momentum", strength: 1000, lookback: 0 }] })),
    ).toThrow(/momentum.lookback/);
    expect(() =>
      parsePortfolioSpec(specJson({ signals: [{ type: "equal_weight", strength: 1000, lookback: 5 }] })),
    ).toThrow(/takes no params/);
  });

  test("enforces policy ranges", () => {
    expect(() => parsePortfolioSpec(specJson({ policy: { drift_threshold: 9, max_trade: 2000, max_price_impact: 100 } }))).toThrow(/drift_threshold/);
    expect(() => parsePortfolioSpec(specJson({ policy: { drift_threshold: 500, max_trade: 99, max_price_impact: 100 } }))).toThrow(/max_trade/);
    expect(() => parsePortfolioSpec(specJson({ policy: { drift_threshold: 500, max_trade: 2000, max_price_impact: 1001 } }))).toThrow(/max_price_impact/);
    expect(() => parsePortfolioSpec(specJson({ policy: { drift_threshold: 500 } }))).toThrow(/max_trade is required/);
  });

  test("rejects unsatisfiable constraints at parse time, not at 3am", () => {
    expect(() =>
      parsePortfolioSpec(specJson({ constraints: { min_weight: 3000, max_weight: 9000 } })),
    ).toThrow(/unsatisfiable/); // 4 x 3000 > 10000
    expect(() =>
      parsePortfolioSpec(specJson({ constraints: { min_weight: 0, max_weight: 2000 } })),
    ).toThrow(/unsatisfiable/); // 4 x 2000 < 10000
  });

  test("accepts per-asset constraint overrides", () => {
    const spec = parsePortfolioSpec(
      specJson({ constraints: { min_weight: 0, max_weight: 10000, max_per_asset: { [USDC]: 5000 } } }),
    );
    expect(spec.constraints.maxBps.get(USDC)).toBe(5000n);
    expect(spec.constraints.maxBps.get(WETH)).toBe(10000n);
  });

  test("rejects a per-asset override for an asset outside the universe", () => {
    expect(() =>
      parsePortfolioSpec(specJson({ constraints: { max_per_asset: { DAI: 1000 } } })),
    ).toThrow(/not in spec.universe/);
  });
});

// ---------------------------------------------------------------------------

describe("requiredHistoryPeriods", () => {
  test("is zero when no signal needs history", () => {
    expect(requiredHistoryPeriods(parsePortfolioSpec(specJson()))).toBe(0);
    expect(
      requiredHistoryPeriods(parsePortfolioSpec(specJson({ signals: [{ type: "equal_weight", strength: 1000 }] }))),
    ).toBe(0);
  });

  test("is the largest lookback across signals, plus one, floored at the volatility minimum", () => {
    const spec = parsePortfolioSpec(
      specJson({
        signals: [
          { type: "inverse_volatility", strength: 3000, lookback: 20 },
          { type: "momentum", strength: 3000, lookback: 5 },
        ],
      }),
    );
    expect(requiredHistoryPeriods(spec)).toBe(21);
    const tiny = parsePortfolioSpec(specJson({ signals: [{ type: "momentum", strength: 1000, lookback: 1 }] }));
    expect(requiredHistoryPeriods(tiny)).toBe(MIN_HISTORY_PERIODS);
  });
});

// ---------------------------------------------------------------------------

describe("composeTargets", () => {
  test("with no signals, the target is the base allocation", () => {
    const { spec, ctx } = ctxFor(specJson());
    expect(composeTargets(spec, ctx)).toEqual(spec.baseWeightsBps);
  });

  test("a zero-strength signal is inert", () => {
    const { spec, ctx } = ctxFor(specJson({ signals: [{ type: "momentum", strength: 0, lookback: 10 }] }));
    expect(composeTargets(spec, ctx)).toEqual(spec.baseWeightsBps);
  });

  test("always sums to exactly 10000 bps", () => {
    for (const strength of [1, 2500, 5000, 9999, 10000]) {
      const { spec, ctx } = ctxFor(
        specJson({ signals: [{ type: "inverse_volatility", strength, lookback: 20 }] }),
      );
      expect(sum(composeTargets(spec, ctx))).toBe(10_000n);
    }
  });

  test("inverse_volatility pulls toward the calm asset and away from the choppy one", () => {
    const { spec, ctx } = ctxFor(
      specJson({ signals: [{ type: "inverse_volatility", strength: 10000, lookback: 20 }] }),
    );
    const targets = composeTargets(spec, ctx);
    expect(targets.get(USDC)!).toBeGreaterThan(spec.baseWeightsBps.get(USDC)!); // flat
    expect(targets.get(WBTC)!).toBeLessThan(spec.baseWeightsBps.get(WBTC)!); // choppy
  });

  test("momentum pulls toward the riser and away from the faller", () => {
    const { spec, ctx } = ctxFor(specJson({ signals: [{ type: "momentum", strength: 10000, lookback: 20 }] }));
    const targets = composeTargets(spec, ctx);
    expect(targets.get(WETH)!).toBeGreaterThan(spec.baseWeightsBps.get(WETH)!); // climbing
    expect(targets.get(LINK)!).toBeLessThan(spec.baseWeightsBps.get(LINK)!); // declining
  });

  test("two signals compose as a convex combination with the base", () => {
    // Bounds wide open so this checks composition alone, not clamping.
    const unbounded = { min_weight: 0, max_weight: 10000 };
    const base = parsePortfolioSpec(specJson({ constraints: unbounded })).baseWeightsBps;
    const only = (signal: Record<string, unknown>) => {
      const { spec, ctx } = ctxFor(specJson({ signals: [signal], constraints: unbounded }));
      return composeTargets(spec, ctx);
    };
    const iv = only({ type: "inverse_volatility", strength: 10000, lookback: 20 });
    const mom = only({ type: "momentum", strength: 10000, lookback: 20 });

    const { spec, ctx } = ctxFor(
      specJson({
        signals: [
          { type: "inverse_volatility", strength: 3000, lookback: 20 },
          { type: "momentum", strength: 2000, lookback: 20 },
        ],
        constraints: unbounded,
      }),
    );
    const both = composeTargets(spec, ctx);
    for (const tokenId of spec.universe) {
      const expected =
        (5000n * base.get(tokenId)! + 3000n * iv.get(tokenId)! + 2000n * mom.get(tokenId)!) / 10_000n;
      // Within the rounding the exact-sum fix redistributes (a few bps).
      const diff = both.get(tokenId)! - expected;
      expect(diff >= -3n && diff <= 3n).toBe(true);
    }
  });

  test("per-asset constraints hold under full tilt", () => {
    const { spec, ctx } = ctxFor(
      specJson({
        signals: [{ type: "inverse_volatility", strength: 10000, lookback: 20 }],
        constraints: { min_weight: 500, max_weight: 10000, max_per_asset: { [USDC]: 3500 } },
      }),
    );
    const targets = composeTargets(spec, ctx);
    expect(targets.get(USDC)!).toBeLessThanOrEqual(3500n); // would otherwise dominate
    for (const weight of targets.values()) {
      expect(weight).toBeGreaterThanOrEqual(500n);
    }
    expect(sum(targets)).toBe(10_000n);
  });

  test("the same market gives two users two different portfolios", () => {
    // This is the product: one deployed workflow, two secret specs.
    const conservative = ctxFor(
      specJson({
        base: { [WETH]: 2000, [WBTC]: 1000, [LINK]: 0, [USDC]: 7000 },
        signals: [{ type: "inverse_volatility", strength: 8000, lookback: 20 }],
      }),
    );
    const aggressive = ctxFor(
      specJson({
        base: { [WETH]: 4000, [WBTC]: 4000, [LINK]: 2000, [USDC]: 0 },
        signals: [{ type: "momentum", strength: 6000, lookback: 10 }],
        constraints: { min_weight: 0, max_weight: 6000 },
      }),
    );
    const a = composeTargets(conservative.spec, conservative.ctx);
    const b = composeTargets(aggressive.spec, aggressive.ctx);
    expect(a.get(USDC)!).toBeGreaterThan(b.get(USDC)!);
    expect(b.get(WETH)!).toBeGreaterThan(a.get(WETH)!);
  });

  test("moves the target when the market moves, which is the whole point", () => {
    const { spec, ctx } = ctxFor(
      specJson({ signals: [{ type: "inverse_volatility", strength: 6000, lookback: 20 }] }),
    );
    const calm = composeTargets(spec, ctx);
    const stressed = composeTargets(spec, {
      ...ctx,
      history: new Map(HISTORY).set(WETH, series(2000, 0, 15, 30)), // WETH turns violent
    });
    expect(stressed.get(WETH)!).toBeLessThan(calm.get(WETH)!);
  });

  test("a flat asset under inverse_volatility is floored, not infinite", () => {
    const { spec, ctx } = ctxFor(
      specJson({
        signals: [{ type: "inverse_volatility", strength: 10000, lookback: 20 }],
        constraints: { min_weight: 0, max_weight: 10000 },
      }),
    );
    const constant = new Map(HISTORY).set(USDC, new Array(30).fill(e8("1")));
    const targets = composeTargets(spec, { ...ctx, history: constant });
    expect(sum(targets)).toBe(10_000n);
    expect(targets.get(USDC)!).toBeLessThan(10_000n);
    void MIN_VOLATILITY_E8;
  });

  test("is deterministic", () => {
    const { spec, ctx } = ctxFor(
      specJson({
        signals: [
          { type: "inverse_volatility", strength: 4000, lookback: 20 },
          { type: "momentum", strength: 3000, lookback: 10 },
        ],
      }),
    );
    expect(composeTargets(spec, ctx)).toEqual(composeTargets(spec, ctx));
  });
});

// ---------------------------------------------------------------------------

describe("signal registry", () => {
  test("exposes the shipped blocks", () => {
    expect(knownSignalTypes()).toEqual(["equal_weight", "inverse_volatility", "momentum"]);
  });
});

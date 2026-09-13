import { describe, expect, test } from "bun:test";

import { parseDecimalToScaled } from "./main";
import {
  MIN_HISTORY_PERIODS,
  MIN_VOLATILITY_E8,
  clampAndRedistribute,
  computeTrailingReturn,
  computeVolatility,
  integerSqrt,
  normalizeToBps,
  parsePriceHistory,
  uniformBounds,
} from "./signal";

const e8 = (value: string): bigint => parseDecimalToScaled(value, 8, "test");

const A = "TKA";
const B = "TKB";
const C = "TKC";

const sum = (weights: Map<string, bigint>): bigint =>
  [...weights.values()].reduce((total, value) => total + value, 0n);

// ---------------------------------------------------------------------------

describe("integerSqrt", () => {
  test("exact squares", () => {
    expect(integerSqrt(0n)).toBe(0n);
    expect(integerSqrt(1n)).toBe(1n);
    expect(integerSqrt(144n)).toBe(12n);
    expect(integerSqrt(10n ** 16n)).toBe(10n ** 8n);
  });

  test("truncates toward zero", () => {
    expect(integerSqrt(2n)).toBe(1n);
    expect(integerSqrt(143n)).toBe(11n);
    expect(integerSqrt(145n)).toBe(12n);
  });

  test("handles values far beyond float64 precision", () => {
    const big = 10n ** 40n;
    expect(integerSqrt(big)).toBe(10n ** 20n);
  });

  test("rejects negatives", () => {
    expect(() => integerSqrt(-1n)).toThrow(/negative/);
  });
});

// ---------------------------------------------------------------------------

describe("computeVolatility", () => {
  test("measures a known alternating series", () => {
    // +10%, -10%, +10%, -10%, +10% -> sample stdev of those five returns.
    const prices = [
      e8("100"),
      e8("110"),
      e8("99"),
      e8("108.9"),
      e8("98.01"),
      e8("107.811"),
    ];
    // mean = 2e6; deviations 8e6/-1.2e7 -> variance 1.2e14 -> stdev 1.0954e7
    expect(computeVolatility(prices, "t")).toBe(10_954_451n);
  });

  test("floors a perfectly flat series instead of returning zero", () => {
    // Constant compounding gives identical returns and therefore zero sample
    // variance. Inverse-vol weighting would divide by it.
    const flat = [e8("100"), e8("110"), e8("121"), e8("133.1"), e8("146.41"), e8("161.051")];
    expect(computeVolatility(flat, "t")).toBe(MIN_VOLATILITY_E8);
  });

  test("a genuinely constant price also floors", () => {
    const constant = new Array(MIN_HISTORY_PERIODS).fill(e8("100"));
    expect(computeVolatility(constant, "t")).toBe(MIN_VOLATILITY_E8);
  });

  test("refuses too little history rather than guessing", () => {
    const short = new Array(MIN_HISTORY_PERIODS - 1).fill(e8("100"));
    expect(() => computeVolatility(short, "t")).toThrow(/at least/);
  });

  test("refuses a broken feed", () => {
    const withZero = [e8("100"), e8("110"), e8("0"), e8("108"), e8("98"), e8("107")];
    expect(() => computeVolatility(withZero, "t")).toThrow(/non-positive price/);
  });

  test("is scale-invariant: a 10x price level gives the same volatility", () => {
    const low = [e8("10"), e8("11"), e8("9.9"), e8("10.89"), e8("9.801"), e8("10.7811")];
    const high = [e8("100"), e8("110"), e8("99"), e8("108.9"), e8("98.01"), e8("107.811")];
    expect(computeVolatility(low, "t")).toBe(computeVolatility(high, "t"));
  });
});

// ---------------------------------------------------------------------------

describe("computeTrailingReturn", () => {
  test("measures last over first", () => {
    expect(computeTrailingReturn([e8("100"), e8("90"), e8("110")], "t")).toBe(10_000_000n); // +10%
    expect(computeTrailingReturn([e8("100"), e8("120"), e8("80")], "t")).toBe(-20_000_000n); // -20%
  });

  test("refuses fewer than two prices or a broken feed", () => {
    expect(() => computeTrailingReturn([e8("100")], "t")).toThrow(/at least 2/);
    expect(() => computeTrailingReturn([e8("0"), e8("100")], "t")).toThrow(/non-positive/);
  });
});

// ---------------------------------------------------------------------------

describe("normalizeToBps", () => {
  test("scales scores to exactly 10000", () => {
    const weights = normalizeToBps(new Map([[A, 1n], [B, 1n], [C, 1n]]))!;
    expect(sum(weights)).toBe(10_000n);
    // 3333 each leaves 1 bp; largest-remainder gives it to the first by id.
    expect([...weights.values()].sort()).toEqual([3333n, 3333n, 3334n]);
  });

  test("returns null for an all-zero score set instead of dividing by zero", () => {
    expect(normalizeToBps(new Map([[A, 0n], [B, 0n]]))).toBeNull();
  });

  test("rejects negative scores", () => {
    expect(() => normalizeToBps(new Map([[A, -1n], [B, 5n]]))).toThrow(/negative/);
  });

  test("is deterministic", () => {
    const scores = new Map([[C, 7n], [A, 3n], [B, 5n]]);
    expect(normalizeToBps(scores)).toEqual(normalizeToBps(new Map(scores)));
  });
});

// ---------------------------------------------------------------------------

describe("clampAndRedistribute", () => {
  test("leaves an in-bounds vector alone", () => {
    const weights = new Map([[A, 5000n], [B, 3000n], [C, 2000n]]);
    const result = clampAndRedistribute(weights, uniformBounds([A, B, C], 500n, 6000n));
    expect(result).toEqual(weights);
  });

  test("water-fills a ceiling breach into the assets with headroom", () => {
    // C wants 90%; capped at 40%, the other 50% must land on A and B.
    const weights = new Map([[A, 500n], [B, 500n], [C, 9000n]]);
    const result = clampAndRedistribute(weights, uniformBounds([A, B, C], 500n, 4000n));
    expect(result.get(C)).toBe(4000n);
    expect(sum(result)).toBe(10_000n);
    for (const weight of result.values()) {
      expect(weight).toBeGreaterThanOrEqual(500n);
      expect(weight).toBeLessThanOrEqual(4000n);
    }
  });

  test("honours a per-asset override", () => {
    const bounds = uniformBounds([A, B, C], 0n, 10_000n);
    bounds.maxBps.set(C, 1000n); // "never more than 10% in C"
    const result = clampAndRedistribute(new Map([[A, 2000n], [B, 2000n], [C, 6000n]]), bounds);
    expect(result.get(C)).toBe(1000n);
    expect(sum(result)).toBe(10_000n);
  });

  test("rejects unsatisfiable bounds instead of looping", () => {
    expect(() =>
      clampAndRedistribute(new Map([[A, 1n], [B, 1n], [C, 1n]]), uniformBounds([A, B, C], 4000n, 9000n)),
    ).toThrow(/unsatisfiable/); // 3 x 4000 > 10000
    expect(() =>
      clampAndRedistribute(new Map([[A, 1n], [B, 1n], [C, 1n]]), uniformBounds([A, B, C], 100n, 3000n)),
    ).toThrow(/unsatisfiable/); // 3 x 3000 < 10000
  });
});

// ---------------------------------------------------------------------------

describe("parsePriceHistory", () => {
  test("parses oldest-first series into 1e8", () => {
    const history = parsePriceHistory(
      { [A]: ["0.05", "0.051"], [B]: ["1.00", "1.01"] },
      parseDecimalToScaled,
    );
    expect(history.get(A)).toEqual([5_000_000n, 5_100_000n]);
  });

  test("rejects a non-array series", () => {
    expect(() => parsePriceHistory({ [A]: "0.05" }, parseDecimalToScaled)).toThrow(
      /not an array/,
    );
  });

  test("rejects an empty payload", () => {
    expect(() => parsePriceHistory({}, parseDecimalToScaled)).toThrow(/no series/);
  });
});

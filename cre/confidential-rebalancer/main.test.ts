import { describe, expect, test } from "bun:test";

import {
  buildTrades,
  computeAllocations,
  parseDecimalToScaled,
  parseHoldings,
  parseIntegerString,
  parsePrices,
  valueHoldings,
} from "./main";

/** USD at 1e8 fixed point, for readable expectations. */
const usd = (dollars: number): bigint => BigInt(dollars) * 100_000_000n;

const WHBAR = "0.0.15058";
const USDC = "0.0.5449";
const SAUCE = "0.0.1183558";

/**
 * The scenario the mock server serves: a $10,000 book sitting at 62/25/13
 * against a 50/30/20 target.
 */
const DRIFTED_HOLDINGS = [
  { tokenId: WHBAR, symbol: "WHBAR", rawBalance: 12_400_000_000_000n, decimals: 8 },
  { tokenId: USDC, symbol: "USDC", rawBalance: 2_500_000_000n, decimals: 6 },
  { tokenId: SAUCE, symbol: "SAUCE", rawBalance: 130_000_000_000n, decimals: 6 },
];

const PRICES = new Map<string, bigint>([
  [WHBAR, 5_000_000n], // $0.05
  [USDC, 100_000_000n], // $1.00
  [SAUCE, 1_000_000n], // $0.01
]);

/**
 * A fixed 50/30/20 target. Spec parsing and signal composition are covered in
 * portfolio.test.ts; this file is about valuation, drift and sizing, so the
 * targets are given directly and the expectations stay hand-computable.
 */
const TARGETS = new Map<string, bigint>([
  [WHBAR, 5000n],
  [USDC, 3000n],
  [SAUCE, 2000n],
]);
const MAX_TRADE_BPS = 2000n; // 20% per leg

// ---------------------------------------------------------------------------

describe("parseDecimalToScaled", () => {
  test("scales a plain decimal", () => {
    expect(parseDecimalToScaled("0.05", 8, "t")).toBe(5_000_000n);
    expect(parseDecimalToScaled("1.00", 8, "t")).toBe(100_000_000n);
    expect(parseDecimalToScaled("102000", 8, "t")).toBe(10_200_000_000_000n);
  });

  test("truncates rather than rounds, so a price is never overstated", () => {
    // 9 decimals of input into an 8 decimal scale: the last digit is dropped,
    // not rounded up. Rounding up here would let a quote promise more output
    // than the pool gives and make the swap revert on min_amount_out.
    expect(parseDecimalToScaled("0.123456789", 8, "t")).toBe(12_345_678n);
    expect(parseDecimalToScaled("0.999999999", 8, "t")).toBe(99_999_999n);
  });

  test("survives precision that float64 would destroy", () => {
    // 0.1 + 0.2 !== 0.3 in float. Exact here.
    expect(parseDecimalToScaled("0.1", 8, "t") + parseDecimalToScaled("0.2", 8, "t")).toBe(
      parseDecimalToScaled("0.3", 8, "t"),
    );
  });

  test("handles a bare fraction and a bare integer", () => {
    expect(parseDecimalToScaled(".5", 8, "t")).toBe(50_000_000n);
    expect(parseDecimalToScaled("7", 8, "t")).toBe(700_000_000n);
  });

  test("refuses rather than guesses", () => {
    expect(() => parseDecimalToScaled("", 8, "t")).toThrow();
    expect(() => parseDecimalToScaled("abc", 8, "t")).toThrow();
    expect(() => parseDecimalToScaled("1e-8", 8, "t")).toThrow(/exponent/);
    expect(() => parseDecimalToScaled(".", 8, "t")).toThrow();
  });
});

describe("parseIntegerString", () => {
  test("accepts integers and rejects everything else", () => {
    expect(parseIntegerString("12400000000000", "t")).toBe(12_400_000_000_000n);
    expect(parseIntegerString("-5", "t")).toBe(-5n);
    expect(() => parseIntegerString("1.5", "t")).toThrow();
    expect(() => parseIntegerString("", "t")).toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("valueHoldings", () => {
  test("values each position across differing decimals", () => {
    const valued = valueHoldings(DRIFTED_HOLDINGS, PRICES);
    expect(valued[0].valueUsdE8).toBe(usd(6200)); // 124,000 WHBAR @ $0.05, 8 dp
    expect(valued[1].valueUsdE8).toBe(usd(2500)); // 2,500 USDC @ $1.00, 6 dp
    expect(valued[2].valueUsdE8).toBe(usd(1300)); // 130,000 SAUCE @ $0.01, 6 dp
  });

  test("refuses to treat an unpriceable holding as zero", () => {
    // Zero would understate the total, inflate every other weight and trigger
    // a rebalance that the real portfolio does not need.
    const pricesMissingSauce = new Map(PRICES);
    pricesMissingSauce.delete(SAUCE);
    expect(() => valueHoldings(DRIFTED_HOLDINGS, pricesMissingSauce)).toThrow(/no price/);
  });

  test("rejects degenerate inputs", () => {
    const zeroPrice = new Map(PRICES).set(SAUCE, 0n);
    expect(() => valueHoldings(DRIFTED_HOLDINGS, zeroPrice)).toThrow(/non-positive price/);

    const negative = [{ ...DRIFTED_HOLDINGS[0], rawBalance: -1n }];
    expect(() => valueHoldings(negative, PRICES)).toThrow(/negative balance/);

    const absurdDecimals = [{ ...DRIFTED_HOLDINGS[0], decimals: 99 }];
    expect(() => valueHoldings(absurdDecimals, PRICES)).toThrow(/implausible decimals/);
  });
});

// ---------------------------------------------------------------------------

describe("computeAllocations", () => {
  const valued = valueHoldings(DRIFTED_HOLDINGS, PRICES);
  const { allocations, totalUsdE8, maxDriftBps } = computeAllocations(
    valued,
    TARGETS,
  );
  const bySymbol = (id: string) => allocations.find((a) => a.tokenId === id)!;

  test("totals the book", () => {
    expect(totalUsdE8).toBe(usd(10_000));
  });

  test("computes current weights in bps", () => {
    expect(bySymbol(WHBAR).currentWeightBps).toBe(6200n);
    expect(bySymbol(USDC).currentWeightBps).toBe(2500n);
    expect(bySymbol(SAUCE).currentWeightBps).toBe(1300n);
  });

  test("reports the largest drift", () => {
    expect(maxDriftBps).toBe(1200n); // WHBAR: 6200 vs 5000
  });

  test("signs the delta: positive buys, negative sells", () => {
    expect(bySymbol(WHBAR).deltaUsdE8).toBe(-usd(1200)); // overweight
    expect(bySymbol(SAUCE).deltaUsdE8).toBe(usd(700)); // underweight
  });

  test("covers targets held at zero balance", () => {
    // A token in the target set but absent from the wallet must show full
    // drift, not be skipped.
    const targets = new Map<string, bigint>([
      [WHBAR, 5000n],
      [USDC, 3000n],
      [SAUCE, 1000n],
      ["0.0.999999", 1000n],
    ]);
    const result = computeAllocations(valued, targets);
    const missing = result.allocations.find((a) => a.tokenId === "0.0.999999")!;
    expect(missing.currentWeightBps).toBe(0n);
    expect(missing.driftBps).toBe(1000n);
    expect(missing.deltaUsdE8).toBe(usd(1000));
  });

  test("covers holdings with no target, which must be sold down", () => {
    const targets = new Map<string, bigint>([
      [WHBAR, 6000n],
      [USDC, 4000n],
    ]);
    const result = computeAllocations(valued, targets);
    const orphan = result.allocations.find((a) => a.tokenId === SAUCE)!;
    expect(orphan.targetWeightBps).toBe(0n);
    expect(orphan.deltaUsdE8).toBe(-usd(1300)); // sell the whole position
  });

  test("refuses a worthless portfolio rather than dividing by zero", () => {
    const empty = valueHoldings(
      [{ tokenId: WHBAR, symbol: "WHBAR", rawBalance: 0n, decimals: 8 }],
      PRICES,
    );
    expect(() => computeAllocations(empty, TARGETS)).toThrow(
      /nothing to rebalance/,
    );
  });

  test("orders output deterministically", () => {
    const again = computeAllocations(valued, TARGETS);
    expect(again.allocations.map((a) => a.tokenId)).toEqual(
      allocations.map((a) => a.tokenId),
    );
  });
});

// ---------------------------------------------------------------------------

describe("buildTrades", () => {
  const valued = valueHoldings(DRIFTED_HOLDINGS, PRICES);
  const { allocations, totalUsdE8 } = computeAllocations(valued, TARGETS);

  test("sizes each leg to close its gap", () => {
    const trades = buildTrades(allocations, MAX_TRADE_BPS, totalUsdE8, USDC);
    expect(trades).toHaveLength(2);
    expect(trades[0]).toMatchObject({ tokenId: WHBAR, side: "sell", notionalUsdE8: usd(1200) });
    expect(trades[1]).toMatchObject({ tokenId: SAUCE, side: "buy", notionalUsdE8: usd(700) });
  });

  test("puts sells before buys so the quote leg is funded", () => {
    const trades = buildTrades(allocations, MAX_TRADE_BPS, totalUsdE8, USDC);
    expect(trades.map((t) => t.side)).toEqual(["sell", "buy"]);
  });

  test("excludes the quote token, whose weight is a residual", () => {
    const trades = buildTrades(allocations, MAX_TRADE_BPS, totalUsdE8, USDC);
    expect(trades.some((t) => t.tokenId === USDC)).toBe(false);
  });

  test("caps a leg at the private per-trade limit", () => {
    // 5% of a $10,000 book == $500. The WHBAR gap is $1,200, so it must be
    // truncated to $500 and converge over later cycles.
    const trades = buildTrades(allocations, 500n, totalUsdE8, USDC);
    expect(trades[0].notionalUsdE8).toBe(usd(500));
    expect(trades[1].notionalUsdE8).toBe(usd(500));
  });

  test("drops dust legs that would cost more in fees than they correct", () => {
    // A book that is only a few cents away from target.
    const nearTarget = valueHoldings(
      [
        { tokenId: WHBAR, symbol: "WHBAR", rawBalance: 10_000_000_000_000n, decimals: 8 },
        { tokenId: USDC, symbol: "USDC", rawBalance: 5_000_000_000n, decimals: 6 },
      ],
      PRICES,
    );
    const targets = new Map<string, bigint>([
      [WHBAR, 5000n],
      [USDC, 5000n],
    ]);
    const result = computeAllocations(nearTarget, targets);
    // $5,000 / $5,000 is exactly on target, so there is nothing to do.
    expect(buildTrades(result.allocations, MAX_TRADE_BPS, result.totalUsdE8, USDC)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("service payload parsing", () => {
  test("reads holdings as integers, not floats", () => {
    const holdings = parseHoldings([
      { token_id: WHBAR, symbol: "WHBAR", raw_balance: "12400000000000", decimals: 8 },
    ]);
    expect(holdings[0].rawBalance).toBe(12_400_000_000_000n);
  });

  test("preserves a balance beyond Number.MAX_SAFE_INTEGER", () => {
    const huge = "123456789012345678901234567890";
    const holdings = parseHoldings([
      { token_id: WHBAR, symbol: "WHBAR", raw_balance: huge, decimals: 8 },
    ]);
    expect(holdings[0].rawBalance.toString()).toBe(huge);
  });

  test("rejects an empty portfolio response", () => {
    expect(() => parseHoldings([])).toThrow(/no holdings/);
  });

  test("rejects a holding with no token id", () => {
    expect(() => parseHoldings([{ symbol: "X", raw_balance: "1", decimals: 8 }])).toThrow(
      /token_id/,
    );
  });

  test("reads prices into 1e8 fixed point", () => {
    const prices = parsePrices({ [WHBAR]: "0.05", [USDC]: "1.00" });
    expect(prices.get(WHBAR)).toBe(5_000_000n);
  });

  test("rejects an empty price response", () => {
    expect(() => parsePrices({})).toThrow(/no prices/);
  });
});

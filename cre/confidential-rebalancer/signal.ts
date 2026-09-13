/**
 * Signal math primitives.
 *
 * Everything here is a pure function over fixed-point bigint. The signal
 * blocks in signals/ compose these into "what should I hold?" answers, and
 * portfolio.ts composes the blocks into a final target vector.
 *
 * ---------------------------------------------------------------------------
 * Numeric policy: all fixed-point bigint, matching main.ts.
 *   prices, returns, volatility : 1e8  ("_e8")
 *   weights, tilt strength      : bps  ("_bps")
 * Simple returns are used rather than log returns -- see computeVolatility.
 * ---------------------------------------------------------------------------
 */

import { BPS_DENOMINATOR, E8_SCALE } from "./numeric";

/**
 * Minimum prices required to estimate volatility.
 *
 * Below this the sample variance is too noisy to tilt on: with 4 returns a
 * single outlier dominates, and the resulting weights would swing violently
 * cycle to cycle, churning the book in fees.
 */
export const MIN_HISTORY_PERIODS = 6;

/**
 * Volatility floor, 1 bp expressed at 1e8.
 *
 * A perfectly flat price series (a stablecoin, or a stale feed) has zero
 * measured volatility, and inverse-volatility weighting would divide by it.
 * Flooring rather than special-casing keeps the function total: a flat asset
 * gets a large but finite tilt, which the weight bounds then cap.
 */
export const MIN_VOLATILITY_E8 = 10_000n;

/** Iteration cap for the clamp/redistribute loop. */
const MAX_REBALANCE_PASSES = 16;

export type Bounds = {
  /** token_id -> floor in bps. Missing == 0. */
  minBps: Map<string, bigint>;
  /** token_id -> ceiling in bps. Missing == 10000. */
  maxBps: Map<string, bigint>;
};

export const uniformBounds = (
  tokenIds: Iterable<string>,
  minBps: bigint,
  maxBps: bigint,
): Bounds => {
  const min = new Map<string, bigint>();
  const max = new Map<string, bigint>();
  for (const tokenId of tokenIds) {
    min.set(tokenId, minBps);
    max.set(tokenId, maxBps);
  }
  return { minBps: min, maxBps: max };
};

/**
 * Integer square root by Newton's method, truncating toward zero.
 *
 * Used instead of Math.sqrt because volatility feeds position sizing, and a
 * float round-trip would make the derived weights depend on IEEE-754 rounding
 * rather than on the prices.
 */
export const integerSqrt = (value: bigint): bigint => {
  if (value < 0n) {
    throw new Error(`integerSqrt: negative input ${value}`);
  }
  if (value < 2n) {
    return value;
  }
  let previous = value;
  let current = (value + 1n) / 2n;
  while (current < previous) {
    previous = current;
    current = (current + value / current) / 2n;
  }
  return previous;
};

/**
 * Sample standard deviation of simple returns, at 1e8 fixed point.
 *
 * `prices` must be oldest-first and strictly point-in-time: the caller is
 * responsible for passing only closed periods. Including the current,
 * still-forming period would leak the present into the signal and make a
 * backtest of this strategy optimistic.
 *
 * Simple returns (p1 - p0) / p0 are used rather than log returns because a
 * logarithm has no exact fixed-point form and would force a float. Over the
 * short lookbacks this signal uses, the two agree to well within the noise of
 * the estimate itself.
 *
 * Bessel's correction (n - 1) is applied: this is a sample of returns drawn
 * from an unknown process, not the whole population.
 */
export const computeVolatility = (pricesE8: bigint[], label: string): bigint => {
  if (pricesE8.length < MIN_HISTORY_PERIODS) {
    throw new Error(
      `${label}: need at least ${MIN_HISTORY_PERIODS} prices to estimate volatility, got ${pricesE8.length}`,
    );
  }

  const returnsE8: bigint[] = [];
  for (let index = 1; index < pricesE8.length; index++) {
    const previous = pricesE8[index - 1];
    const current = pricesE8[index];

    // A non-positive price is a broken feed, not a 100% drawdown. Refuse.
    if (previous <= 0n || current <= 0n) {
      throw new Error(
        `${label}: non-positive price in history at index ${index} (${previous} -> ${current})`,
      );
    }
    returnsE8.push(((current - previous) * E8_SCALE) / previous);
  }

  const count = BigInt(returnsE8.length);
  const meanE8 = returnsE8.reduce((sum, value) => sum + value, 0n) / count;

  // Sum of squared deviations. Each term is (1e8-scaled)^2 == 1e16-scaled, so
  // the sqrt below lands back on the 1e8 scale.
  const sumSquaredDeviations = returnsE8.reduce((sum, value) => {
    const deviation = value - meanE8;
    return sum + deviation * deviation;
  }, 0n);

  const varianceE16 = sumSquaredDeviations / (count - 1n);
  const volatilityE8 = integerSqrt(varianceE16);

  return volatilityE8 > MIN_VOLATILITY_E8 ? volatilityE8 : MIN_VOLATILITY_E8;
};

/**
 * Trailing simple return over the whole series, at 1e8.
 *
 * (last - first) / first. Oldest-first, point-in-time, same caveats as
 * computeVolatility.
 */
export const computeTrailingReturn = (pricesE8: bigint[], label: string): bigint => {
  if (pricesE8.length < 2) {
    throw new Error(`${label}: need at least 2 prices for a return, got ${pricesE8.length}`);
  }
  const first = pricesE8[0];
  const last = pricesE8[pricesE8.length - 1];
  if (first <= 0n || last <= 0n) {
    throw new Error(`${label}: non-positive price in history (${first} -> ${last})`);
  }
  return ((last - first) * E8_SCALE) / first;
};

/**
 * Force a weight map to sum to exactly BPS_DENOMINATOR, without breaching any
 * per-asset bound.
 *
 * Integer division leaves a remainder of a few bps that has to land somewhere.
 * Largest-remainder assignment is used rather than dumping it on the first or
 * biggest asset, and ties break on token id so the result is deterministic --
 * two nodes computing the same targets must agree bit for bit.
 */
export const forceExactSum = (
  weightsBps: Map<string, bigint>,
  remainders: Map<string, bigint>,
  bounds: Bounds,
): Map<string, bigint> => {
  const total = [...weightsBps.values()].reduce((sum, value) => sum + value, 0n);
  let deficit = BPS_DENOMINATOR - total;
  if (deficit === 0n) {
    return weightsBps;
  }

  const ordered = [...weightsBps.keys()].sort((a, b) => {
    const remainderA = remainders.get(a) ?? 0n;
    const remainderB = remainders.get(b) ?? 0n;
    if (remainderA !== remainderB) {
      return remainderA > remainderB ? -1 : 1;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });

  // Single-bp steps, skipping any asset that has no room in the needed
  // direction. Nudging a weight through its bound to make the total add up
  // would quietly violate the risk limit the bound exists to enforce.
  const step = deficit > 0n ? 1n : -1n;
  let index = 0;
  const limit = ordered.length * 20_000;
  while (deficit !== 0n) {
    if (index > limit) {
      throw new Error("forceExactSum: cannot reach 100% within the per-asset bounds");
    }
    const tokenId = ordered[index % ordered.length];
    const next = (weightsBps.get(tokenId) ?? 0n) + step;
    const lo = bounds.minBps.get(tokenId) ?? 0n;
    const hi = bounds.maxBps.get(tokenId) ?? BPS_DENOMINATOR;
    if (next >= lo && next <= hi) {
      weightsBps.set(tokenId, next);
      deficit -= step;
    }
    index++;
  }

  return weightsBps;
};

/**
 * Clamp weights into their per-asset bounds and redistribute the difference
 * across the assets that are still free to move.
 *
 * Water-filling: a surplus is distributed in proportion to each asset's
 * remaining headroom, an excess in proportion to its slack above the floor.
 * A single clamp-then-renormalise pass is not enough -- renormalising can push
 * a previously-legal weight back outside its bound, and pinning every
 * out-of-bounds asset leaves nothing to absorb the difference.
 */
export const clampAndRedistribute = (
  weightsBps: Map<string, bigint>,
  bounds: Bounds,
): Map<string, bigint> => {
  const tokenIds = [...weightsBps.keys()].sort();
  const lo = (tokenId: string): bigint => bounds.minBps.get(tokenId) ?? 0n;
  const hi = (tokenId: string): bigint => bounds.maxBps.get(tokenId) ?? BPS_DENOMINATOR;

  let sumMin = 0n;
  let sumMax = 0n;
  for (const tokenId of tokenIds) {
    if (lo(tokenId) > hi(tokenId)) {
      throw new Error(`bounds for ${tokenId}: min ${lo(tokenId)} exceeds max ${hi(tokenId)}`);
    }
    sumMin += lo(tokenId);
    sumMax += hi(tokenId);
  }
  // Bounds the asset count makes unsatisfiable would loop forever below.
  if (sumMin > BPS_DENOMINATOR) {
    throw new Error(`sum of minimum weights ${sumMin} bps exceeds 100%; bounds are unsatisfiable`);
  }
  if (sumMax < BPS_DENOMINATOR) {
    throw new Error(`sum of maximum weights ${sumMax} bps is below 100%; bounds are unsatisfiable`);
  }

  const clampOne = (tokenId: string, weight: bigint): bigint => {
    if (weight < lo(tokenId)) return lo(tokenId);
    if (weight > hi(tokenId)) return hi(tokenId);
    return weight;
  };

  const working = new Map<string, bigint>();
  for (const tokenId of tokenIds) {
    working.set(tokenId, clampOne(tokenId, weightsBps.get(tokenId) ?? 0n));
  }

  for (let pass = 0; pass < MAX_REBALANCE_PASSES; pass++) {
    const total = [...working.values()].reduce((sum, value) => sum + value, 0n);
    const deficit = BPS_DENOMINATOR - total;
    if (deficit === 0n) {
      break;
    }

    if (deficit > 0n) {
      let totalHeadroom = 0n;
      const headroom = new Map<string, bigint>();
      for (const tokenId of tokenIds) {
        const room = hi(tokenId) - (working.get(tokenId) ?? 0n);
        headroom.set(tokenId, room);
        totalHeadroom += room;
      }
      if (totalHeadroom <= 0n) {
        break; // every asset at its ceiling; forceExactSum will report it
      }
      for (const tokenId of tokenIds) {
        const share = (deficit * (headroom.get(tokenId) ?? 0n)) / totalHeadroom;
        working.set(tokenId, (working.get(tokenId) ?? 0n) + share);
      }
    } else {
      let totalSlack = 0n;
      const slack = new Map<string, bigint>();
      for (const tokenId of tokenIds) {
        const room = (working.get(tokenId) ?? 0n) - lo(tokenId);
        slack.set(tokenId, room);
        totalSlack += room;
      }
      if (totalSlack <= 0n) {
        break; // every asset at its floor
      }
      const excess = -deficit;
      for (const tokenId of tokenIds) {
        const share = (excess * (slack.get(tokenId) ?? 0n)) / totalSlack;
        working.set(tokenId, (working.get(tokenId) ?? 0n) - share);
      }
    }

    for (const tokenId of tokenIds) {
      working.set(tokenId, clampOne(tokenId, working.get(tokenId) ?? 0n));
    }
  }

  return working;
};

/**
 * Turn arbitrary non-negative scores into a weight vector summing to exactly
 * 10000 bps, proportionally. Returns null if every score is zero, so the
 * caller can decide what "no signal" means rather than dividing by zero.
 */
export const normalizeToBps = (scores: Map<string, bigint>): Map<string, bigint> | null => {
  let total = 0n;
  for (const [tokenId, score] of scores) {
    if (score < 0n) {
      throw new Error(`normalizeToBps: negative score for ${tokenId}`);
    }
    total += score;
  }
  if (total <= 0n) {
    return null;
  }

  const weights = new Map<string, bigint>();
  const remainders = new Map<string, bigint>();
  for (const [tokenId, score] of scores) {
    weights.set(tokenId, (score * BPS_DENOMINATOR) / total);
    remainders.set(tokenId, (score * BPS_DENOMINATOR) % total);
  }
  return forceExactSum(weights, remainders, uniformBounds(scores.keys(), 0n, BPS_DENOMINATOR));
};

/**
 * Parse a price-history payload into oldest-first 1e8 series.
 *
 * Shape: { "<token_id>": ["0.050", "0.051", ...], ... }
 */
export const parsePriceHistory = (
  payload: unknown,
  parseDecimal: (raw: string, scale: number, label: string) => bigint,
): Map<string, bigint[]> => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("price history response is not an object");
  }

  const history = new Map<string, bigint[]>();
  for (const [tokenId, series] of Object.entries(payload as Record<string, unknown>)) {
    if (!Array.isArray(series)) {
      throw new Error(`price history for ${tokenId} is not an array`);
    }
    history.set(
      tokenId,
      series.map((entry, index) =>
        parseDecimal(String(entry), 8, `history price ${tokenId}[${index}]`),
      ),
    );
  }

  if (history.size === 0) {
    throw new Error("price history response contained no series");
  }
  return history;
};

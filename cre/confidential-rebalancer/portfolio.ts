/**
 * The portfolio layer.
 *
 * A PortfolioSpec is one secret document that fully describes how a user's
 * portfolio is constructed: what it may hold, the strategic view, which
 * signals tilt that view and by how much, what must never happen, and when to
 * act. The enclave reads the spec and builds the portfolio from it.
 *
 * Two users on the same deployed workflow can run entirely different
 * portfolios built entirely different ways, and the public code reveals only
 * that "a spec is evaluated" -- not which assets, which signals, or how they
 * are weighted.
 *
 * Composition is a convex combination:
 *
 *     target = (1 - sum(strength_k)) * base + sum_k strength_k * view_k
 *
 * so strengths read as "how much of the final portfolio this signal decides",
 * with the remainder left to the strategic view. Order-independent by
 * construction. Then per-asset constraints are applied and the vector is
 * forced to sum to exactly 10000 bps.
 */

import {
  BPS_DENOMINATOR,
  type Range,
  asObject,
  parseIntegerValue,
  requireInRange,
} from "./numeric";
import { type Bounds, clampAndRedistribute, forceExactSum } from "./signal";
import { type SignalBlock, type SignalContext, resolveSignalBlock } from "./signals";
import { MIN_HISTORY_PERIODS } from "./signal";

// ---------------------------------------------------------------------------
// Validation bounds
//
// Outside these a value is more likely a misparse than an intention: a 0.001%
// drift band would rebalance continuously, and a 90% single trade would move
// the market against itself.
// ---------------------------------------------------------------------------

const DRIFT_THRESHOLD_BPS_RANGE: Range = { min: 10n, max: 5_000n }; // 0.1% .. 50%
const MAX_TRADE_BPS_RANGE: Range = { min: 100n, max: 10_000n }; // 1% .. 100%
const MAX_PRICE_IMPACT_BPS_RANGE: Range = { min: 1n, max: 1_000n }; // 0.01% .. 10%
const WEIGHT_BPS_RANGE: Range = { min: 0n, max: BPS_DENOMINATOR };
const STRENGTH_BPS_RANGE: Range = { min: 0n, max: BPS_DENOMINATOR };

/** A spec may name at most this many assets. Keeps the HTTP payloads bounded. */
const MAX_UNIVERSE_SIZE = 32;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SignalSpec = {
  type: string;
  /** Share of the final target this signal decides, in bps. */
  strengthBps: bigint;
  params: unknown;
  block: SignalBlock<unknown>;
};

export type PortfolioSpec = {
  /** Sorted, unique token ids the portfolio may hold. */
  universe: string[];
  /** The token every buy is funded from and every sell settles into. */
  quote: string;
  /** token_id -> strategic base weight in bps. Sums to exactly 10000. Keys are a subset of universe. */
  baseWeightsBps: Map<string, bigint>;
  signals: SignalSpec[];
  constraints: Bounds;
  policy: {
    driftThresholdBps: bigint;
    maxTradeBps: bigint;
    maxPriceImpactBps: bigint;
  };
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const parseUniverse = (raw: unknown): string[] => {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("spec.universe must be a non-empty array of token ids");
  }
  if (raw.length > MAX_UNIVERSE_SIZE) {
    throw new Error(`spec.universe lists ${raw.length} assets; max is ${MAX_UNIVERSE_SIZE}`);
  }
  const ids = raw.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error("spec.universe entries must be non-empty strings");
    }
    return entry.trim();
  });
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    throw new Error("spec.universe contains duplicates");
  }
  return [...unique].sort();
};

const parseWeights = (raw: unknown, universe: Set<string>, label: string): Map<string, bigint> => {
  const entries = Object.entries(asObject(raw));
  if (entries.length === 0) {
    throw new Error(`${label} contains no allocations`);
  }
  const weights = new Map<string, bigint>();
  let sum = 0n;
  for (const [tokenId, rawWeight] of entries) {
    if (!universe.has(tokenId)) {
      throw new Error(`${label} names ${tokenId}, which is not in spec.universe`);
    }
    const weight = requireInRange(
      parseIntegerValue(rawWeight, `${label}.${tokenId}`),
      WEIGHT_BPS_RANGE,
      `${label}.${tokenId}`,
    );
    weights.set(tokenId, weight);
    sum += weight;
  }
  // No tolerance: bps are integers, so "33/33/33" is a real error the user
  // should be told about rather than have quietly rescaled behind their back.
  if (sum !== BPS_DENOMINATOR) {
    throw new Error(`${label} must sum to exactly ${BPS_DENOMINATOR} bps`);
  }
  return weights;
};

const parseSignals = (raw: unknown): SignalSpec[] => {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("spec.signals must be an array");
  }

  let totalStrength = 0n;
  const signals = raw.map((entry, index) => {
    const record = asObject(entry);
    const type = String(record.type ?? "").trim();
    if (type === "") {
      throw new Error(`spec.signals[${index}] is missing a type`);
    }
    const block = resolveSignalBlock(type);
    const strengthBps = requireInRange(
      parseIntegerValue(record.strength, `spec.signals[${index}].strength`),
      STRENGTH_BPS_RANGE,
      `spec.signals[${index}].strength`,
    );
    totalStrength += strengthBps;

    // Everything except type and strength belongs to the block.
    const { type: _type, strength: _strength, ...params } = record;
    return { type, strengthBps, params: block.parseParams(params), block };
  });

  // Strengths are shares of the final target; more than 100% is not a
  // portfolio, it is a leverage instruction this layer does not express.
  if (totalStrength > BPS_DENOMINATOR) {
    throw new Error(`spec.signals strengths must not exceed ${BPS_DENOMINATOR} bps in total`);
  }
  return signals;
};

const parseConstraints = (raw: unknown, universe: string[]): Bounds => {
  const record = asObject(raw);
  const minWeight = requireInRange(
    parseIntegerValue(record.min_weight ?? 0, "spec.constraints.min_weight"),
    WEIGHT_BPS_RANGE,
    "spec.constraints.min_weight",
  );
  const maxWeight = requireInRange(
    parseIntegerValue(record.max_weight ?? BPS_DENOMINATOR, "spec.constraints.max_weight"),
    WEIGHT_BPS_RANGE,
    "spec.constraints.max_weight",
  );
  if (minWeight > maxWeight) {
    throw new Error("spec.constraints: min_weight exceeds max_weight");
  }

  const minBps = new Map<string, bigint>();
  const maxBps = new Map<string, bigint>();
  for (const tokenId of universe) {
    minBps.set(tokenId, minWeight);
    maxBps.set(tokenId, maxWeight);
  }

  // Per-asset overrides win over the global bound for that asset only.
  const applyOverrides = (key: string, target: Map<string, bigint>) => {
    for (const [tokenId, rawValue] of Object.entries(asObject(record[key]))) {
      if (!universe.includes(tokenId)) {
        throw new Error(`spec.constraints.${key} names ${tokenId}, which is not in spec.universe`);
      }
      target.set(
        tokenId,
        requireInRange(
          parseIntegerValue(rawValue, `spec.constraints.${key}.${tokenId}`),
          WEIGHT_BPS_RANGE,
          `spec.constraints.${key}.${tokenId}`,
        ),
      );
    }
  };
  applyOverrides("min_per_asset", minBps);
  applyOverrides("max_per_asset", maxBps);

  // Feasibility is checked here, at parse time, so a bad spec is rejected when
  // it is written rather than at 3am when the cron fires.
  let sumMin = 0n;
  let sumMax = 0n;
  for (const tokenId of universe) {
    const lo = minBps.get(tokenId) ?? 0n;
    const hi = maxBps.get(tokenId) ?? BPS_DENOMINATOR;
    if (lo > hi) {
      throw new Error("spec.constraints: a per-asset min exceeds its max");
    }
    sumMin += lo;
    sumMax += hi;
  }
  if (sumMin > BPS_DENOMINATOR) {
    throw new Error("spec.constraints: minimum weights sum to over 100%; unsatisfiable");
  }
  if (sumMax < BPS_DENOMINATOR) {
    throw new Error("spec.constraints: maximum weights sum to under 100%; unsatisfiable");
  }

  return { minBps, maxBps };
};

const parsePolicy = (raw: unknown): PortfolioSpec["policy"] => {
  const record = asObject(raw);
  const required = (key: string, range: Range) => {
    if (record[key] === undefined) {
      throw new Error(`spec.policy.${key} is required`);
    }
    return requireInRange(parseIntegerValue(record[key], `spec.policy.${key}`), range, `spec.policy.${key}`);
  };
  return {
    driftThresholdBps: required("drift_threshold", DRIFT_THRESHOLD_BPS_RANGE),
    maxTradeBps: required("max_trade", MAX_TRADE_BPS_RANGE),
    maxPriceImpactBps: required("max_price_impact", MAX_PRICE_IMPACT_BPS_RANGE),
  };
};

/**
 * Parse and validate a spec from its JSON text.
 *
 * Note what is deliberately absent: a schedule. The cron trigger fires on the
 * DON, outside the enclave, so the cadence is necessarily public and lives in
 * the workflow config instead. Putting it in the spec would only pretend it
 * was secret.
 */
export const parsePortfolioSpec = (json: string): PortfolioSpec => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`portfolio spec is not valid JSON: ${message}`);
  }
  const record = asObject(decoded);
  if (Object.keys(record).length === 0) {
    throw new Error("portfolio spec is empty");
  }

  const universe = parseUniverse(record.universe);
  const universeSet = new Set(universe);

  const quote = String(record.quote ?? "").trim();
  if (!universeSet.has(quote)) {
    throw new Error(`spec.quote "${quote}" must be a member of spec.universe`);
  }

  const baseWeightsBps = parseWeights(record.base, universeSet, "spec.base");
  // Universe members without a base weight hold zero strategically.
  for (const tokenId of universe) {
    if (!baseWeightsBps.has(tokenId)) {
      baseWeightsBps.set(tokenId, 0n);
    }
  }

  return {
    universe,
    quote,
    baseWeightsBps,
    signals: parseSignals(record.signals),
    constraints: parseConstraints(record.constraints, universe),
    policy: parsePolicy(record.policy),
  };
};

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** Prices per token the spec's signals need. Zero if no signal needs history. */
export const requiredHistoryPeriods = (spec: PortfolioSpec): number => {
  let periods = 0;
  for (const signal of spec.signals) {
    periods = Math.max(periods, signal.block.requiredHistory(signal.params));
  }
  // computeVolatility has a hard floor; asking for less than that from the
  // service would be wasted round trip followed by an error.
  return periods > 0 ? Math.max(periods, MIN_HISTORY_PERIODS) : 0;
};

/**
 * This cycle's target weights.
 *
 * Runs inside the enclave. The result is the most sensitive value in the
 * system: it exists only here, only for the duration of the call.
 */
export const composeTargets = (spec: PortfolioSpec, ctx: SignalContext): Map<string, bigint> => {
  const views: { strengthBps: bigint; weights: Map<string, bigint> }[] = [];
  let signalStrength = 0n;

  for (const signal of spec.signals) {
    if (signal.strengthBps === 0n) {
      continue; // a zero-strength signal is inert; do not even compute it
    }
    const weights = signal.block.compute(ctx, signal.params);
    if (weights === null) {
      continue; // "no view" defers its share to the base allocation
    }
    views.push({ strengthBps: signal.strengthBps, weights });
    signalStrength += signal.strengthBps;
  }

  const baseStrength = BPS_DENOMINATOR - signalStrength;
  const blended = new Map<string, bigint>();
  const remainders = new Map<string, bigint>();

  for (const tokenId of spec.universe) {
    let numerator = baseStrength * (spec.baseWeightsBps.get(tokenId) ?? 0n);
    for (const view of views) {
      numerator += view.strengthBps * (view.weights.get(tokenId) ?? 0n);
    }
    blended.set(tokenId, numerator / BPS_DENOMINATOR);
    remainders.set(tokenId, numerator % BPS_DENOMINATOR);
  }

  const bounded = clampAndRedistribute(blended, spec.constraints);
  return forceExactSum(bounded, remainders, spec.constraints);
};

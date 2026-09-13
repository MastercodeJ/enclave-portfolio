/**
 * Inverse-volatility (risk-parity) tilt.
 *
 * Each asset's base weight is divided by its realized volatility, so calmer
 * assets are held in larger size and wilder ones in smaller. The result is
 * base-weighted rather than pure 1/vol: this is "my strategic view, scaled by
 * risk", not "ignore my view and equalise risk". For the latter, compose
 * equal_weight and inverse_volatility.
 */

import { E8_SCALE, parseIntegerValue, requireInRange } from "../numeric";
import { MIN_HISTORY_PERIODS, computeVolatility, normalizeToBps } from "../signal";
import { type SignalBlock, tail } from "./types";

export type InverseVolatilityParams = {
  /** Return periods in the volatility window. */
  lookback: number;
};

/**
 * The floor is one below what computeVolatility needs in *prices*, since a
 * lookback of N returns needs N + 1 prices. The ceiling keeps one HTTP
 * response inside the simulator's 250kb limit.
 */
const LOOKBACK_RANGE = { min: BigInt(MIN_HISTORY_PERIODS - 1), max: 499n };

export const inverseVolatility: SignalBlock<InverseVolatilityParams> = {
  type: "inverse_volatility",

  parseParams(raw) {
    const lookback = requireInRange(
      parseIntegerValue(raw.lookback, "inverse_volatility.lookback"),
      LOOKBACK_RANGE,
      "inverse_volatility.lookback",
    );
    return { lookback: Number(lookback) };
  },

  requiredHistory(params) {
    return params.lookback + 1;
  },

  compute(ctx, params) {
    const scores = new Map<string, bigint>();
    for (const tokenId of ctx.universe) {
      const series = ctx.history.get(tokenId);
      if (series === undefined) {
        throw new Error(`inverse_volatility: no price history for ${tokenId}`);
      }
      const window = tail(series, params.lookback + 1, `inverse_volatility ${tokenId}`);
      const volatilityE8 = computeVolatility(window, `volatility for ${tokenId}`);
      const baseBps = ctx.baseWeightsBps.get(tokenId) ?? 0n;
      scores.set(tokenId, (baseBps * E8_SCALE) / volatilityE8);
    }
    return normalizeToBps(scores);
  },
};

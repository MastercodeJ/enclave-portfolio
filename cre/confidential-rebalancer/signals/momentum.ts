/**
 * Trailing-return (momentum) tilt.
 *
 * Each asset's base weight is scaled by (1 + trailing return): an asset up 10%
 * over the window is held at 1.1x its base, one down 10% at 0.9x. An asset
 * that has lost everything scores zero rather than negative -- a weight
 * cannot be negative, and the composer's floor bound decides whether it is
 * held at all.
 *
 * This is deliberately the simplest possible momentum definition. The value
 * of the block is in *composing* it with others under a secret strength, not
 * in the sophistication of the signal itself.
 */

import { E8_SCALE, parseIntegerValue, requireInRange } from "../numeric";
import { computeTrailingReturn, normalizeToBps } from "../signal";
import { type SignalBlock, tail } from "./types";

export type MomentumParams = {
  /** Periods in the return window. */
  lookback: number;
};

const LOOKBACK_RANGE = { min: 1n, max: 499n };

export const momentum: SignalBlock<MomentumParams> = {
  type: "momentum",

  parseParams(raw) {
    const lookback = requireInRange(
      parseIntegerValue(raw.lookback, "momentum.lookback"),
      LOOKBACK_RANGE,
      "momentum.lookback",
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
        throw new Error(`momentum: no price history for ${tokenId}`);
      }
      const window = tail(series, params.lookback + 1, `momentum ${tokenId}`);
      const returnE8 = computeTrailingReturn(window, `return for ${tokenId}`);
      const baseBps = ctx.baseWeightsBps.get(tokenId) ?? 0n;

      // (1 + r) at 1e8, floored at zero. Division by E8_SCALE brings the score
      // back to bps magnitude so it composes on the same scale as base.
      const multiplierE8 = E8_SCALE + returnE8;
      const score = multiplierE8 > 0n ? (baseBps * multiplierE8) / E8_SCALE : 0n;
      scores.set(tokenId, score);
    }
    return normalizeToBps(scores);
  },
};

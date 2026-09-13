/**
 * Equal weight across the universe.
 *
 * Ignores the base allocation entirely. Useful on its own as a naive
 * benchmark, and useful in composition as a way to pull a concentrated base
 * toward diversification by a secret amount.
 */

import { normalizeToBps } from "../signal";
import type { SignalBlock } from "./types";

export type EqualWeightParams = Record<string, never>;

export const equalWeight: SignalBlock<EqualWeightParams> = {
  type: "equal_weight",

  parseParams(raw) {
    const keys = Object.keys(raw);
    if (keys.length > 0) {
      throw new Error(`equal_weight takes no params, got ${keys.join(", ")}`);
    }
    return {};
  },

  requiredHistory() {
    return 0;
  },

  compute(ctx) {
    const scores = new Map<string, bigint>();
    for (const tokenId of ctx.universe) {
      scores.set(tokenId, 1n);
    }
    return normalizeToBps(scores);
  },
};

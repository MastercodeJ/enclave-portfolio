/**
 * The contract every signal block satisfies.
 *
 * A block answers one question -- "given the market, what would I hold?" --
 * as a full weight vector summing to exactly 10000 bps. It does not blend,
 * clamp or know about other blocks; portfolio.ts does that. Keeping blocks
 * pure means each one is testable in isolation and any two compose.
 */

export type SignalContext = {
  /** Token ids in the spec's universe, sorted. */
  universe: string[];
  /** token_id -> strategic base weight in bps. Sums to exactly 10000. */
  baseWeightsBps: Map<string, bigint>;
  /** token_id -> oldest-first price series at 1e8. */
  history: Map<string, bigint[]>;
  /** token_id -> spot price at 1e8. */
  pricesE8: Map<string, bigint>;
};

export type SignalBlock<TParams> = {
  readonly type: string;
  /** Validate the block's params from the spec. Refuse, never guess. */
  parseParams(raw: Record<string, unknown>): TParams;
  /** Prices this block needs per token, so the fetch can size the request. */
  requiredHistory(params: TParams): number;
  /**
   * The block's view, as a weight vector in bps summing to exactly 10000.
   * Returns null when the block has no view (e.g. every score is zero); the
   * composer treats that as "defer to base".
   */
  compute(ctx: SignalContext, params: TParams): Map<string, bigint> | null;
};

/** Take the last `count` elements, refusing if there are not enough. */
export const tail = (series: bigint[], count: number, label: string): bigint[] => {
  if (series.length < count) {
    throw new Error(`${label}: need ${count} prices, got ${series.length}`);
  }
  return series.slice(series.length - count);
};

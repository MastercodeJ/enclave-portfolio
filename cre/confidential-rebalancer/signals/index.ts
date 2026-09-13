/**
 * Signal block registry.
 *
 * The spec names blocks by `type`; this is the only place that string is
 * resolved to code. Adding a block is: write it, register it here. Nothing
 * else in the system needs to know it exists.
 */

import { equalWeight } from "./equal_weight";
import { inverseVolatility } from "./inverse_volatility";
import { momentum } from "./momentum";
import type { SignalBlock } from "./types";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous param types by design
const REGISTRY: ReadonlyMap<string, SignalBlock<any>> = new Map<string, SignalBlock<any>>([
  [inverseVolatility.type, inverseVolatility],
  [momentum.type, momentum],
  [equalWeight.type, equalWeight],
]);

// biome-ignore lint/suspicious/noExplicitAny: see above
export const resolveSignalBlock = (type: string): SignalBlock<any> => {
  const block = REGISTRY.get(type);
  if (block === undefined) {
    throw new Error(
      `unknown signal type "${type}"; known: ${[...REGISTRY.keys()].sort().join(", ")}`,
    );
  }
  return block;
};

export const knownSignalTypes = (): string[] => [...REGISTRY.keys()].sort();

export type { SignalBlock, SignalContext } from "./types";

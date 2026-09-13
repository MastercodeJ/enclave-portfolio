/**
 * Confidential portfolio rebalancer.
 *
 * The strategy is a PortfolioSpec (see portfolio.ts): universe, strategic
 * base allocation, the signals that tilt it, per-asset constraints and the
 * rebalancing policy. It is one secret, decrypted only inside a Nitro enclave,
 * and never crosses back out to the Workflow DON.
 *
 * What leaves the enclave is the trade list alone: symbol, side, notional,
 * min_amount_out. An observer learns that a rebalance happened and what was
 * swapped. They do not learn the weights that implied it, the drift band that
 * triggered it, or the caps that shaped it.
 *
 * Crucially, the target weights are not stored anywhere either -- they are
 * composed each cycle from the spec's signals over live prices. A fixed target
 * would be recoverable by watching the book before and after a rebalance; a
 * target that moves with market conditions the observer cannot parameterise
 * is not.
 *
 * ---------------------------------------------------------------------------
 * Numeric policy (see also: quant standards)
 *
 * Token amounts are integers in base units, carried as bigint. They are never
 * converted to `number` -- a float64 silently loses precision above 2^53, which
 * is ~90 HBAR at 8 decimals for a raw balance, and far less headroom for an
 * 18-decimal ERC-20.
 *
 * USD values are fixed-point bigint scaled by 1e8 (`_e8` suffix). Weights and
 * drifts are dimensionless ratios expressed in basis points (bigint, `_bps`).
 * Every division rounds toward zero, which for a sell rounds the notional down
 * and for a buy rounds the notional down -- never in the trader's favour.
 *
 * `number` appears only for display strings in log lines.
 * ---------------------------------------------------------------------------
 */

import {
  CronCapability,
  HTTPClient,
  NITRO_REGIONS,
  Runner,
  handlerInTee,
  type TeeRuntime,
  type Workflow,
} from "@chainlink/cre-sdk";

import {
  BPS_DENOMINATOR,
  E8_DECIMALS as USD_DECIMALS,
  E8_SCALE as USD_SCALE,
  asObject,
  parseDecimalToScaled,
  parseIntegerString,
} from "./numeric";
import {
  type PortfolioSpec,
  composeTargets,
  parsePortfolioSpec,
  requiredHistoryPeriods,
} from "./portfolio";
import { type Rpc } from "./rpc";
import { type UniswapConfig, uniswapVenue } from "./uniswap";
import {
  type ExecutableTrade,
  type Holding,
  type MockConfig,
  type PlannedTrade,
  type Venue,
  mockVenue,
} from "./venue";

export { parseDecimalToScaled, parseIntegerString } from "./numeric";
export { parseHoldings, parsePrices } from "./venue";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Trades below this notional are dropped rather than emitted.
 *
 * Rationale: a $1 rebalance leg costs more in gas and spread than the tracking
 * error it corrects. This is a floor on *emitted* trades, not on drift
 * measurement -- drift is still computed exactly.
 */
const MIN_TRADE_NOTIONAL_E8 = 1n * USD_SCALE; // $1.00

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SecretsConfig = {
  /** The PortfolioSpec JSON. The entire strategy is this one secret. */
  portfolio_spec_secret_id: string;
  /** Mock venue only: API key for the fixture service. */
  portfolio_api_key_id?: string;
  /** Uniswap venue only: the wallet that holds the portfolio and signs swaps. */
  private_key_id?: string;
};

export type Config = {
  schedule: string;
  venue: "mock" | "uniswap-v3";
  rpc_url: string;
  /** Mock venue settings. */
  mock?: { base_url: string; account_id: string };
  /** Uniswap venue settings. */
  uniswap?: UniswapConfig;
  secrets_ids: SecretsConfig;
};

/** A valued position. */
type ValuedHolding = Holding & {
  priceUsdE8: bigint;
  valueUsdE8: bigint;
};

type Allocation = {
  tokenId: string;
  symbol: string;
  valueUsdE8: bigint;
  currentWeightBps: bigint;
  targetWeightBps: bigint;
  /** Absolute distance from target, in bps. Always >= 0. */
  driftBps: bigint;
  /** Signed: positive means underweight (must buy), negative means overweight. */
  deltaUsdE8: bigint;
};

// ---------------------------------------------------------------------------
// Valuation
// ---------------------------------------------------------------------------

/**
 * Value each holding in USD at 1e8 fixed point.
 *
 * value_e8 = raw_balance * price_e8 / 10^token_decimals
 *
 * The multiply happens before the divide so precision is not lost on small
 * balances. Division truncates, so a position is never overstated.
 */
export const valueHoldings = (
  holdings: Holding[],
  pricesUsdE8: Map<string, bigint>,
): ValuedHolding[] => {
  return holdings.map((holding) => {
    const priceUsdE8 = pricesUsdE8.get(holding.tokenId);

    // A token we hold but cannot price is a hard stop, not a zero. Treating it
    // as zero would understate the portfolio total, inflate every other
    // token's weight, and trigger a spurious rebalance.
    if (priceUsdE8 === undefined) {
      throw new Error(
        `no price for held token ${holding.tokenId} (${holding.symbol}); refusing to value portfolio`,
      );
    }
    if (priceUsdE8 <= 0n) {
      throw new Error(
        `non-positive price for ${holding.tokenId} (${holding.symbol}): ${priceUsdE8}`,
      );
    }
    if (holding.rawBalance < 0n) {
      throw new Error(
        `negative balance for ${holding.tokenId} (${holding.symbol}): ${holding.rawBalance}`,
      );
    }
    if (holding.decimals < 0 || holding.decimals > 30) {
      throw new Error(
        `implausible decimals for ${holding.tokenId}: ${holding.decimals}`,
      );
    }

    const tokenScale = 10n ** BigInt(holding.decimals);
    const valueUsdE8 = (holding.rawBalance * priceUsdE8) / tokenScale;

    return { ...holding, priceUsdE8, valueUsdE8 };
  });
};

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

/**
 * Compare current weights against the private targets.
 *
 * Covers the union of held tokens and targeted tokens, so a target with a zero
 * balance still shows full drift (it needs buying), and a held token with no
 * target shows full drift (it needs selling to zero).
 */
export const computeAllocations = (
  valued: ValuedHolding[],
  targetWeightsBps: Map<string, bigint>,
): { allocations: Allocation[]; totalUsdE8: bigint; maxDriftBps: bigint } => {
  const totalUsdE8 = valued.reduce((sum, holding) => sum + holding.valueUsdE8, 0n);

  // An empty or worthless portfolio has no meaningful weights. Refuse rather
  // than divide by zero or emit trades against nothing.
  if (totalUsdE8 <= 0n) {
    throw new Error(
      `portfolio total value is ${totalUsdE8}; nothing to rebalance`,
    );
  }

  const valueByTokenId = new Map<string, ValuedHolding>();
  for (const holding of valued) {
    valueByTokenId.set(holding.tokenId, holding);
  }

  const tokenIds = [
    ...new Set([...targetWeightsBps.keys(), ...valueByTokenId.keys()]),
  ].sort(); // stable ordering: output must not depend on map iteration order

  const allocations = tokenIds.map((tokenId) => {
    const holding = valueByTokenId.get(tokenId);
    const valueUsdE8 = holding?.valueUsdE8 ?? 0n;
    const targetWeightBps = targetWeightsBps.get(tokenId) ?? 0n;
    const currentWeightBps = (valueUsdE8 * BPS_DENOMINATOR) / totalUsdE8;

    const driftBps =
      currentWeightBps > targetWeightBps
        ? currentWeightBps - targetWeightBps
        : targetWeightBps - currentWeightBps;

    return {
      tokenId,
      symbol: holding?.symbol ?? tokenId,
      valueUsdE8,
      currentWeightBps,
      targetWeightBps,
      driftBps,
      // Positive => underweight => buy. Negative => overweight => sell.
      deltaUsdE8: (targetWeightBps * totalUsdE8) / BPS_DENOMINATOR - valueUsdE8,
    } satisfies Allocation;
  });

  const maxDriftBps = allocations.reduce(
    (max, allocation) => (allocation.driftBps > max ? allocation.driftBps : max),
    0n,
  );

  return { allocations, totalUsdE8, maxDriftBps };
};

// ---------------------------------------------------------------------------
// Trade sizing
// ---------------------------------------------------------------------------

/**
 * Turn allocation deltas into sized trades, capped by the private per-trade
 * limit.
 *
 * A capped trade deliberately does NOT fully close the gap this cycle. Partial
 * convergence across successive cron ticks is the intended behaviour -- it is
 * what the per-trade cap is for.
 *
 * The quote token is excluded from trading: it is the funding side of every
 * buy and the settlement side of every sell, so its weight is a residual of the
 * other legs rather than something to trade against itself.
 */
export const buildTrades = (
  allocations: Allocation[],
  maxTradeBps: bigint,
  totalUsdE8: bigint,
  quoteTokenId: string,
): PlannedTrade[] => {
  const maxTradeNotionalE8 = (maxTradeBps * totalUsdE8) / BPS_DENOMINATOR;

  const trades: PlannedTrade[] = [];

  for (const allocation of allocations) {
    if (allocation.tokenId === quoteTokenId) {
      continue;
    }

    const side: "buy" | "sell" = allocation.deltaUsdE8 > 0n ? "buy" : "sell";
    const magnitudeE8 =
      allocation.deltaUsdE8 < 0n ? -allocation.deltaUsdE8 : allocation.deltaUsdE8;

    if (magnitudeE8 === 0n) {
      continue;
    }

    const cappedE8 =
      magnitudeE8 > maxTradeNotionalE8 ? maxTradeNotionalE8 : magnitudeE8;

    // Dust filter applies after capping: if the cap itself is below the dust
    // floor the strategy cannot make progress, and emitting a sub-dollar leg
    // would burn more in fees than it corrects.
    if (cappedE8 < MIN_TRADE_NOTIONAL_E8) {
      continue;
    }

    trades.push({
      tokenId: allocation.tokenId,
      symbol: allocation.symbol,
      side,
      notionalUsdE8: cappedE8,
    });
  }

  // Sells before buys: selling first frees quote-token balance to fund the
  // buys within the same cycle, so a fully-invested portfolio can still
  // rebalance without an external cash injection.
  return trades.sort((a, b) => {
    if (a.side === b.side) {
      return a.tokenId < b.tokenId ? -1 : a.tokenId > b.tokenId ? 1 : 0;
    }
    return a.side === "sell" ? -1 : 1;
  });
};

// ---------------------------------------------------------------------------
// Price-impact check
// ---------------------------------------------------------------------------

/**
 * Ask the venue to quote each trade, and drop any leg whose price impact
 * breaches the private cap.
 *
 * This check runs INSIDE the enclave on purpose. Emitting maxPriceImpactBps
 * alongside the trade and letting the executor enforce it would publish the
 * cap, which is part of the strategy. Enforcing it here means the outside world
 * sees only a min_amount_out -- which it needs anyway to execute -- and never
 * learns the threshold that produced it.
 */
const applyPriceImpactCap = (
  runtime: TeeRuntime<Config>,
  venue: Venue,
  trades: PlannedTrade[],
  maxPriceImpactBps: bigint,
  quoteTokenId: string,
): ExecutableTrade[] => {
  const executable: ExecutableTrade[] = [];
  const quotes = venue.quotes(trades, quoteTokenId);
  for (const [index, trade] of trades.entries()) {
    const quote = quotes[index];
    if (quote.impactBps < 0n) {
      throw new Error(`negative price impact for ${trade.tokenId}`);
    }
    if (quote.amountOut <= 0n) {
      throw new Error(`non-positive quote output for ${trade.tokenId}`);
    }
    if (quote.impactBps > maxPriceImpactBps) {
      // Deliberately does not name the threshold in the log.
      runtime.log(`skip-leg token=${trade.tokenId} reason=price-impact`);
      continue;
    }
    executable.push({
      ...trade,
      minAmountOut: quote.amountOut,
      destinationTokenId: trade.side === "buy" ? trade.tokenId : quoteTokenId,
    });
  }
  return executable;
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Runs inside the enclave.
 *
 * Logging discipline: runtime.log lines are visible outside the enclave, so
 * nothing derived from the spec may appear in one. Targets, weights, drift and
 * caps are all spec-derived. Only counts, token ids and coarse status words are
 * logged.
 */
export const onCronTrigger = async (runtime: TeeRuntime<Config>): Promise<string> => {
  const config = runtime.config;
  const ids = config.secrets_ids;

  // ---- 1. the spec, and the venue --------------------------------------
  const wanted = [{ id: ids.portfolio_spec_secret_id }];
  if (ids.portfolio_api_key_id) wanted.push({ id: ids.portfolio_api_key_id });
  if (ids.private_key_id) wanted.push({ id: ids.private_key_id });
  const secrets = runtime.getSecrets(wanted).result();

  const spec: PortfolioSpec = parsePortfolioSpec(secrets[ids.portfolio_spec_secret_id].value);
  const client = new HTTPClient();

  let venue: Venue;
  let accountId: string;
  if (config.venue === "uniswap-v3") {
    if (!config.uniswap || !ids.private_key_id) throw new Error("uniswap venue requires config.uniswap and secrets_ids.private_key_id");
    const rpc: Rpc = { runtime, client, url: config.rpc_url, nextId: 1 };
    venue = uniswapVenue(rpc, config.uniswap, normalizePrivateKey(secrets[ids.private_key_id].value));
    accountId = "wallet";
  } else {
    if (!config.mock || !ids.portfolio_api_key_id) throw new Error("mock venue requires config.mock and secrets_ids.portfolio_api_key_id");
    const mock: MockConfig = { ...config.mock, api_key: secrets[ids.portfolio_api_key_id].value };
    venue = mockVenue(runtime, client, mock);
    accountId = config.mock.account_id;
  }

  // ---- 2. public inputs --------------------------------------------------
  const holdings: Holding[] = venue.holdings(spec.universe);
  const pricesUsdE8 = venue.prices(spec.universe);

  // Price history is public data, but the lookbacks applied to it, the signals
  // that consume it and the strengths they compose at are all in the spec --
  // so the targets that come out cannot be reproduced from the prices alone.
  const periods = requiredHistoryPeriods(spec);
  const history = periods > 0 ? venue.history(spec.universe, periods) : new Map<string, bigint[]>();

  // ---- 3. the decision ---------------------------------------------------
  const targetWeightsBps = composeTargets(spec, {
    universe: spec.universe,
    baseWeightsBps: spec.baseWeightsBps,
    history,
    pricesE8: pricesUsdE8,
  });

  const valued = valueHoldings(holdings, pricesUsdE8);
  const { allocations, totalUsdE8, maxDriftBps } = computeAllocations(valued, targetWeightsBps);

  // The comparison itself is the secret. Only the boolean outcome escapes.
  if (maxDriftBps < spec.policy.driftThresholdBps) {
    runtime.log("rebalance-skip reason=within-band");
    return "NOOP";
  }

  const planned = buildTrades(allocations, spec.policy.maxTradeBps, totalUsdE8, spec.quote);
  if (planned.length === 0) {
    runtime.log("rebalance-skip reason=no-actionable-legs");
    return "NOOP";
  }

  const executable = applyPriceImpactCap(runtime, venue, planned, spec.policy.maxPriceImpactBps, spec.quote);
  if (executable.length === 0) {
    runtime.log("rebalance-skip reason=all-legs-exceeded-impact");
    return "NOOP";
  }

  // ---- 4. what leaves the enclave ---------------------------------------
  // Note what is absent: no spec, no targets, no drift, no caps. Only orders.
  const executionId = await venue.execute(executable, accountId);
  runtime.log(`rebalance-executed legs=${executable.length}`);

  return JSON.stringify({ status: "EXECUTED", tradeCount: executable.length, executionId });
};

/**
 * viem wants a 0x-prefixed 32-byte hex key; wallets export it either way.
 * Normalise without ever echoing the value.
 */
const normalizePrivateKey = (raw: string): `0x${string}` => {
  const trimmed = raw.trim();
  const hex = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("private key secret is not a 32-byte hex string");
  }
  return `0x${hex}`;
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const initWorkflow = (config: Config): Workflow<Config> => {
  if (!config.schedule || !config.rpc_url || !config.venue) {
    throw new Error("config requires schedule, rpc_url and venue");
  }
  if (!config.secrets_ids?.portfolio_spec_secret_id) {
    throw new Error("config requires secrets_ids.portfolio_spec_secret_id");
  }

  const cron = new CronCapability();

  return [
    // The third argument is the TEE constraint, and it is what actually pins
    // execution to an enclave. Nitro is the only backing available today, and
    // us-west-2 the only region, but naming both explicitly means a future
    // region being added cannot silently relocate the strategy.
    handlerInTee(cron.trigger({ schedule: config.schedule }), onCronTrigger, [
      { tee: "nitro", regions: [NITRO_REGIONS[0]] },
    ]),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}

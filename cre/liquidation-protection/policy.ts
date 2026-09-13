/**
 * Liquidation-protection policy: the decision, as pure integer math.
 *
 * Runs inside the enclave. Every input except the on-chain position is
 * secret; the output is one or two transactions.
 *
 * Two layers:
 *
 *   1. Buffer. Hold enough collateral that the position survives down to a
 *      secret FLOOR PRICE with debt untouched. Deposits do not change debt, so
 *      this costs nothing in loan continuity, and because it is done before
 *      any price moves there is no race against checkAllHF(). One action.
 *
 *   2. Reactive. If the price goes below the floor anyway and hf falls under
 *      the secret TRIGGER, top up collateral to reach the secret TARGET; if
 *      vETH runs out, repay vUSD up to a secret cap; if even that cannot keep
 *      hf above 100, repay whatever it takes (emergency exit). A cooldown
 *      suppresses non-critical top-ups that would only pad the score.
 *
 * ---------------------------------------------------------------------------
 * Units, exactly as the contract:
 *   collateral, deposits  : vETH units, 100 = 1.00 vETH
 *   debt, repayments      : vUSD units, 100 = 1.00 vUSD
 *   price                 : vUSD units per 1.00 vETH, 200000 = 2000.00
 *   hf                    : x100, liquidated when hf <= 100
 *
 * hf = floor(collateral * price * 78 / (100 * debt))     -- ChallengeLending.calcHF
 * ---------------------------------------------------------------------------
 */

import { asObject, parseIntegerValue, requireInRange } from "../confidential-rebalancer/numeric";

export const LIQUI_THRESHOLD = 78n;
/** Lowest hf the contract does not liquidate. */
export const SURVIVAL_HF = 101n;

export type Policy = {
  /** Pre-emptive buffer survives down to this price. */
  floorPrice: bigint;
  /** Reactive layer acts when hf < this. */
  hfTrigger: bigint;
  /** ...and restores to at least this. */
  hfTarget: bigint;
  /** Per intervention, vETH units. */
  maxDepositUnits: bigint;
  /** Per intervention, percent of the ORIGINAL debt. */
  maxRepayPct: bigint;
  /** Seconds after an action during which non-critical top-ups are skipped. */
  cooldownSeconds: bigint;
};

export type Position = {
  collateral: bigint;
  debt: bigint;
};

export type Market = {
  price: bigint;
  freeVeth: bigint;
  freeVusd: bigint;
  /** start_Debt from the contract: the denominator for maxRepayPct. */
  originalDebt: bigint;
  /** Unix seconds of our last deposit/repay, 0 if none known. */
  lastActionAt: bigint;
  now: bigint;
};

export type Action = { kind: "deposit"; units: bigint } | { kind: "repay"; units: bigint };

export type Decision = {
  actions: Action[];
  /**
   * Coarse, log-safe reason. Never carries a number derived from the policy.
   */
  reason: "no-debt" | "within-policy" | "cooldown" | "buffer" | "reactive" | "emergency" | "no-capital";
};

// ---------------------------------------------------------------------------

const POLICY_RANGES = {
  floorPrice: { min: 50_000n, max: 200_000n }, // $500 .. $2000
  hfTrigger: { min: 101n, max: 150n },
  hfTarget: { min: 101n, max: 200n },
  maxDepositUnits: { min: 1n, max: 10_000n },
  maxRepayPct: { min: 1n, max: 100n },
  cooldownSeconds: { min: 0n, max: 86_400n },
};

export const parsePolicy = (json: string): Policy => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch (error) {
    throw new Error(`policy is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = asObject(decoded);
  // An error message that escapes the enclave is a public log line, so no
  // message here may carry a value -- only which field was wrong.
  const field = (key: keyof typeof POLICY_RANGES, jsonKey: string): bigint => {
    if (record[jsonKey] === undefined) {
      throw new Error(`policy.${jsonKey} is required`);
    }
    try {
      return requireInRange(parseIntegerValue(record[jsonKey], jsonKey), POLICY_RANGES[key], jsonKey);
    } catch {
      throw new Error(`policy.${jsonKey} is invalid`);
    }
  };
  const policy: Policy = {
    floorPrice: field("floorPrice", "floor_price"),
    hfTrigger: field("hfTrigger", "hf_trigger"),
    hfTarget: field("hfTarget", "hf_target"),
    maxDepositUnits: field("maxDepositUnits", "max_deposit_units"),
    maxRepayPct: field("maxRepayPct", "max_repay_pct"),
    cooldownSeconds: field("cooldownSeconds", "cooldown_seconds"),
  };
  if (policy.hfTarget < policy.hfTrigger) {
    throw new Error("policy.hf_target is below policy.hf_trigger");
  }
  return policy;
};

// ---------------------------------------------------------------------------

const ceilDiv = (numerator: bigint, denominator: bigint): bigint =>
  (numerator + denominator - 1n) / denominator;

/** The contract's calcHF, bit for bit. */
export const healthFactor = (collateral: bigint, price: bigint, debt: bigint): bigint => {
  if (debt === 0n) {
    return 2n ** 64n; // the contract stores uint256.max; any large value works here
  }
  return (collateral * price * LIQUI_THRESHOLD) / (100n * debt);
};

/** Smallest collateral with hf(collateral, price, debt) >= wantHf. */
export const collateralFor = (wantHf: bigint, price: bigint, debt: bigint): bigint =>
  ceilDiv(wantHf * 100n * debt, price * LIQUI_THRESHOLD);

/** Largest debt with hf(collateral, price, debt) >= wantHf. */
export const debtFor = (wantHf: bigint, price: bigint, collateral: bigint): bigint =>
  (collateral * price * LIQUI_THRESHOLD) / (100n * wantHf);

const min = (...values: bigint[]): bigint => values.reduce((a, b) => (a < b ? a : b));

/**
 * Decide. Pure: same inputs, same output, on every node and in every test.
 */
export const decide = (policy: Policy, position: Position, market: Market): Decision => {
  const { collateral, debt } = position;
  if (debt === 0n) {
    return { actions: [], reason: "no-debt" };
  }

  const hfNow = healthFactor(collateral, market.price, debt);
  const critical = hfNow < policy.hfTrigger;

  // Collateral required by each layer. The buffer depends only on the floor
  // and the debt, so once satisfied it stays satisfied until debt grows or
  // collateral is seized.
  const bufferCollateral = collateralFor(SURVIVAL_HF, policy.floorPrice, debt);
  const reactiveCollateral = critical ? collateralFor(policy.hfTarget, market.price, debt) : 0n;
  const wantCollateral = bufferCollateral > reactiveCollateral ? bufferCollateral : reactiveCollateral;

  const shortfall = wantCollateral - collateral;
  if (shortfall <= 0n) {
    return { actions: [], reason: "within-policy" };
  }

  // A non-critical top-up only pads the buffer; do not churn.
  if (!critical && market.lastActionAt > 0n && market.now - market.lastActionAt < policy.cooldownSeconds) {
    return { actions: [], reason: "cooldown" };
  }

  const deposit = min(shortfall, policy.maxDepositUnits, market.freeVeth);
  const collateralAfter = collateral + deposit;
  const hfAfterDeposit = healthFactor(collateralAfter, market.price, debt);

  if (!critical) {
    return deposit > 0n
      ? { actions: [{ kind: "deposit", units: deposit }], reason: "buffer" }
      : { actions: [], reason: "no-capital" };
  }

  // Critical. Deposit alone is enough if it lifts us back over the trigger.
  if (hfAfterDeposit >= policy.hfTrigger) {
    return { actions: [{ kind: "deposit", units: deposit }], reason: "reactive" };
  }

  // Otherwise repay toward the target, within the per-intervention cap.
  const maxRepay = (market.originalDebt * policy.maxRepayPct) / 100n;
  const debtForTarget = debtFor(policy.hfTarget, market.price, collateralAfter);
  const cappedRepay = min(debt - debtForTarget, maxRepay, market.freeVusd, debt);
  const actions: Action[] = deposit > 0n ? [{ kind: "deposit", units: deposit }] : [];

  if (cappedRepay > 0n && healthFactor(collateralAfter, market.price, debt - cappedRepay) >= SURVIVAL_HF) {
    return { actions: [...actions, { kind: "repay", units: cappedRepay }], reason: "reactive" };
  }

  // The caps are not enough to survive. Survival is worth 40 points and the
  // caps are not; repay whatever it takes, bounded only by what we hold.
  const debtToSurvive = debtFor(SURVIVAL_HF, market.price, collateralAfter);
  const emergencyRepay = min(debt - debtToSurvive, market.freeVusd, debt);
  if (emergencyRepay > 0n) {
    return { actions: [...actions, { kind: "repay", units: emergencyRepay }], reason: "emergency" };
  }
  return { actions, reason: actions.length > 0 ? "emergency" : "no-capital" };
};

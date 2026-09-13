import { describe, expect, test } from "bun:test";

import {
  type Action,
  type Market,
  type Policy,
  type Position,
  SURVIVAL_HF,
  collateralFor,
  debtFor,
  decide,
  healthFactor,
  parsePolicy,
} from "./policy";

// ---------------------------------------------------------------------------
// A faithful model of ChallengeLending: the same integer math, the same
// partial-liquidation rule, the same time-weighted debt score.
// ---------------------------------------------------------------------------

const START_COLLATERAL = 500n;
const START_DEBT = 700_000n;
const START_FREE_VETH = 500n;
const START_FREE_VUSD = 700_000n;
const START_PRICE = 200_000n;
const MAX_LTV = 75n;
const LIQUI_PENALTY = 5n;
/** Seconds between price updates in the model; only ratios matter for continuity. */
const INTERVAL = 600n;

type Book = {
  collateral: bigint;
  debt: bigint;
  freeVeth: bigint;
  freeVusd: bigint;
  price: bigint;
  now: bigint;
  lastActionAt: bigint;
  ops: number;
  liquidations: number;
  debtTime: bigint; // sum of debt * seconds
  lastDebtChangeAt: bigint;
};

const fresh = (): Book => ({
  collateral: START_COLLATERAL,
  debt: START_DEBT,
  freeVeth: START_FREE_VETH,
  freeVusd: START_FREE_VUSD,
  price: START_PRICE,
  now: 0n,
  lastActionAt: 0n,
  ops: 0,
  liquidations: 0,
  debtTime: 0n,
  lastDebtChangeAt: 0n,
});

const accrueDebtTime = (book: Book) => {
  book.debtTime += book.debt * (book.now - book.lastDebtChangeAt);
  book.lastDebtChangeAt = book.now;
};

const apply = (book: Book, action: Action) => {
  if (action.kind === "deposit") {
    if (action.units > book.freeVeth) throw new Error("deposit exceeds free vETH");
    book.freeVeth -= action.units;
    book.collateral += action.units;
  } else {
    if (action.units > book.freeVusd) throw new Error("repay exceeds free vUSD");
    if (action.units > book.debt) throw new Error("repay exceeds debt");
    accrueDebtTime(book);
    book.freeVusd -= action.units;
    book.debt -= action.units;
  }
  book.ops++;
  book.lastActionAt = book.now;
};

/** ChallengeLending.checkAllHF + liquidateUser. */
const checkAllHF = (book: Book) => {
  if (book.debt === 0n) return;
  if (healthFactor(book.collateral, book.price, book.debt) > 100n) return;
  const collateralValue = (book.collateral * book.price) / 100n;
  const targetDebt = (collateralValue * MAX_LTV) / 100n;
  if (targetDebt >= book.debt) return;
  let debtToRepay = book.debt - targetDebt;
  const seizeValue = (debtToRepay * (100n + LIQUI_PENALTY)) / 100n;
  let seize = (seizeValue * 100n + book.price - 1n) / book.price;
  if (seize > book.collateral) {
    seize = book.collateral;
    debtToRepay = book.debt;
  }
  accrueDebtTime(book);
  book.debt -= debtToRepay;
  book.collateral -= seize;
  book.liquidations++;
};

const marketOf = (book: Book): Market => ({
  price: book.price,
  freeVeth: book.freeVeth,
  freeVusd: book.freeVusd,
  originalDebt: START_DEBT,
  lastActionAt: book.lastActionAt,
  now: book.now,
});

const positionOf = (book: Book): Position => ({ collateral: book.collateral, debt: book.debt });

type Outcome = {
  survived: boolean;
  continuityBps: bigint;
  vethUsed: bigint;
  vusdUsed: bigint;
  ops: number;
  reasons: string[];
};

/**
 * Run one scenario. The workflow gets to act on ChallengeStarted and after
 * every PriceUpdate, before checkAllHF() -- the timing the log trigger gives us.
 */
const runScenario = (policy: Policy | null, path: bigint[]): Outcome => {
  const book = fresh();
  const reasons: string[] = [];

  const act = () => {
    if (policy === null) return; // a participant who deployed nothing
    const decision = decide(policy, positionOf(book), marketOf(book));
    reasons.push(decision.reason);
    for (const action of decision.actions) apply(book, action);
  };

  act(); // ChallengeStarted
  for (const price of path) {
    book.now += INTERVAL;
    book.price = price;
    act(); // PriceUpdate, before the admin's liquidation check
    checkAllHF(book);
  }
  book.now += INTERVAL;
  accrueDebtTime(book); // stop()
  const duration = book.now;

  return {
    survived: book.liquidations === 0,
    continuityBps: (book.debtTime * 10_000n) / (START_DEBT * duration),
    vethUsed: START_FREE_VETH - book.freeVeth,
    vusdUsed: START_FREE_VUSD - book.freeVusd,
    ops: book.ops,
    reasons,
  };
};

const SCENARIOS: Record<string, bigint[]> = {
  "gradual-decline": [185_000n, 175_000n, 165_000n, 155_000n],
  "sudden-crash": [170_000n, 162_500n, 145_000n],
  "temporary-wick": [175_000n, 162_000n, 190_000n],
  "two-stage": [175_000n, 165_000n, 165_000n, 150_000n],
  "safe-volatility": [180_000n, 195_000n, 175_000n, 205_000n],
};

const POLICY: Policy = parsePolicy(
  JSON.stringify({
    floor_price: 130_000,
    hf_trigger: 105,
    hf_target: 115,
    max_deposit_units: 250,
    max_repay_pct: 15,
    cooldown_seconds: 900,
  }),
);

// ---------------------------------------------------------------------------

describe("contract math", () => {
  test("starting position has hf 111 and is liquidatable at 1800", () => {
    expect(healthFactor(500n, 200_000n, 700_000n)).toBe(111n);
    expect(healthFactor(500n, 185_000n, 700_000n)).toBe(103n);
    expect(healthFactor(500n, 180_000n, 700_000n)).toBe(100n); // <= 100: liquidated
    expect(healthFactor(500n, 175_000n, 700_000n)).toBe(97n);
  });

  test("collateralFor is the smallest collateral reaching the hf", () => {
    for (const [hf, price] of [[101n, 130_000n], [115n, 145_000n], [101n, 90_600n]] as const) {
      const c = collateralFor(hf, price, 700_000n);
      expect(healthFactor(c, price, 700_000n)).toBeGreaterThanOrEqual(hf);
      expect(healthFactor(c - 1n, price, 700_000n)).toBeLessThan(hf);
    }
  });

  test("debtFor is the largest debt keeping the hf", () => {
    const d = debtFor(115n, 145_000n, 500n);
    expect(healthFactor(500n, 145_000n, d)).toBeGreaterThanOrEqual(115n);
    expect(healthFactor(500n, 145_000n, d + 1n)).toBeLessThan(115n);
  });

  test("doing nothing is liquidated in every published scenario", () => {
    const liquidated = Object.values(SCENARIOS).filter((path) => !runScenario(null, path).survived).length;
    expect(liquidated).toBe(5);
  });

  test("even a policy with tiny caps survives, because the emergency layer ignores them", () => {
    const timid: Policy = { ...POLICY, floorPrice: 200_000n, hfTrigger: 101n, maxDepositUnits: 1n, maxRepayPct: 1n };
    for (const path of Object.values(SCENARIOS)) {
      const outcome = runScenario(timid, path);
      expect(outcome.survived).toBe(true);
      expect(outcome.continuityBps).toBeLessThan(10_000n); // ...but it pays for it in continuity
    }
  });
});

describe("parsePolicy", () => {
  test("rejects a target below the trigger", () => {
    expect(() =>
      parsePolicy(JSON.stringify({ floor_price: 130000, hf_trigger: 110, hf_target: 105, max_deposit_units: 250, max_repay_pct: 15, cooldown_seconds: 0 })),
    ).toThrow(/hf_target/);
  });
  test("rejects out-of-range and missing fields", () => {
    expect(() => parsePolicy(JSON.stringify({ floor_price: 10, hf_trigger: 105, hf_target: 115, max_deposit_units: 250, max_repay_pct: 15, cooldown_seconds: 0 }))).toThrow(/floor_price/);
    expect(() => parsePolicy(JSON.stringify({ floor_price: 130000 }))).toThrow(/required/);
  });
});

describe("the strategy across the published scenarios", () => {
  for (const [name, path] of Object.entries(SCENARIOS)) {
    test(`${name}: survives with debt untouched in one action`, () => {
      const outcome = runScenario(POLICY, path);
      expect(outcome.survived).toBe(true);
      expect(outcome.continuityBps).toBe(10_000n); // no repay ever needed
      expect(outcome.vusdUsed).toBe(0n);
      expect(outcome.ops).toBe(1); // the buffer deposit at start, nothing else
      expect(outcome.reasons[0]).toBe("buffer");
      expect(outcome.reasons.slice(1).every((r) => r === "within-policy")).toBe(true);
    });
  }

  test("the buffer deposit at a $1,300 floor is 1.98 vETH", () => {
    const outcome = runScenario(POLICY, []);
    expect(outcome.vethUsed).toBe(198n);
  });

  test("a tighter floor uses less capital", () => {
    const tight = { ...POLICY, floorPrice: 145_000n };
    expect(runScenario(tight, []).vethUsed).toBe(126n);
  });
});

describe("below the floor: the reactive layer", () => {
  test("a crash through the floor is met with a top-up, not a repay", () => {
    // 1300 floor; price goes to 1200. Free vETH after the buffer: 3.02.
    const outcome = runScenario(POLICY, [150_000n, 120_000n]);
    expect(outcome.survived).toBe(true);
    expect(outcome.vusdUsed).toBe(0n);
    expect(outcome.ops).toBe(2);
    expect(outcome.reasons).toEqual(["buffer", "within-policy", "reactive"]);
  });

  test("when vETH runs out it repays, within the cap, and survives", () => {
    // A brutal path. Collateral maxes out at 10.00 vETH; below ~$906 only
    // repayment can save the position.
    const outcome = runScenario(POLICY, [150_000n, 110_000n, 85_000n]);
    expect(outcome.survived).toBe(true);
    expect(outcome.vusdUsed).toBeGreaterThan(0n);
    expect(outcome.vusdUsed).toBeLessThanOrEqual((START_DEBT * POLICY.maxRepayPct) / 100n);
    expect(outcome.reasons.at(-1)).toBe("reactive");
  });

  test("when the cap cannot save it, it repays whatever it takes", () => {
    const outcome = runScenario(POLICY, [150_000n, 110_000n, 60_000n]);
    expect(outcome.survived).toBe(true);
    expect(outcome.reasons.at(-1)).toBe("emergency");
  });

  test("a temporary wick below the floor is not answered with a repay", () => {
    const outcome = runScenario(POLICY, [150_000n, 125_000n, 190_000n]);
    expect(outcome.survived).toBe(true);
    expect(outcome.vusdUsed).toBe(0n);
  });
});

describe("discipline", () => {
  test("never acts when already inside policy", () => {
    const book = fresh();
    book.collateral = collateralFor(SURVIVAL_HF, POLICY.floorPrice, book.debt);
    expect(decide(POLICY, positionOf(book), marketOf(book)).actions).toHaveLength(0);
  });

  test("cooldown suppresses a non-critical top-up but never a critical one", () => {
    const book = fresh();
    book.now = 1000n;
    book.lastActionAt = 900n; // acted 100s ago, cooldown is 900s
    // Non-critical: hf is fine now, only the buffer is short.
    expect(decide(POLICY, positionOf(book), marketOf(book)).reason).toBe("cooldown");
    // Critical: price collapsed; cooldown must not apply.
    book.price = 150_000n;
    expect(decide(POLICY, positionOf(book), marketOf(book)).actions.length).toBeGreaterThan(0);
  });

  test("is deterministic", () => {
    const book = fresh();
    expect(decide(POLICY, positionOf(book), marketOf(book))).toEqual(decide(POLICY, positionOf(book), marketOf(book)));
  });

  test("with no debt there is nothing to protect", () => {
    const book = fresh();
    book.debt = 0n;
    expect(decide(POLICY, positionOf(book), marketOf(book)).reason).toBe("no-debt");
  });
});

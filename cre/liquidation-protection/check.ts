/**
 * Replay the published scenarios -- and some harsher ones -- against the
 * policy in cre/.env, using the contract's exact math. Prints outcomes only;
 * never the policy itself.
 *
 *   bun run check
 */
import { parsePolicy, decide, healthFactor, type Policy, type Action } from "./policy";

const policy: Policy = parsePolicy(process.env.LIQUIDATION_POLICY ?? "");

const START = { collateral: 500n, debt: 700_000n, freeVeth: 500n, freeVusd: 700_000n };
const INTERVAL = 600n;

const SCENARIOS: Record<string, number[]> = {
  "gradual-decline": [1850, 1750, 1650, 1550],
  "sudden-crash": [1700, 1625, 1450],
  "temporary-wick": [1750, 1620, 1900],
  "two-stage": [1750, 1650, 1650, 1500],
  "safe-volatility": [1800, 1950, 1750, 2050],
  "harsh: to 1300": [1700, 1500, 1300],
  "harsh: to 1150": [1700, 1450, 1150],
  "harsh: to 1000": [1600, 1300, 1000],
  "harsh: to 850": [1500, 1100, 850],
};

const run = (path: number[]) => {
  const b = { ...START, price: 200_000n, now: 0n, lastActionAt: 0n, ops: 0, liq: 0, debtTime: 0n, lastDebtAt: 0n };
  const accrue = () => { b.debtTime += b.debt * (b.now - b.lastDebtAt); b.lastDebtAt = b.now; };
  const apply = (a: Action) => {
    if (a.kind === "deposit") { b.freeVeth -= a.units; b.collateral += a.units; }
    else { accrue(); b.freeVusd -= a.units; b.debt -= a.units; }
    b.ops++; b.lastActionAt = b.now;
  };
  const act = () => {
    const d = decide(policy, { collateral: b.collateral, debt: b.debt },
      { price: b.price, freeVeth: b.freeVeth, freeVusd: b.freeVusd, originalDebt: START.debt, lastActionAt: b.lastActionAt, now: b.now });
    for (const a of d.actions) apply(a);
  };
  const check = () => {
    if (b.debt === 0n || healthFactor(b.collateral, b.price, b.debt) > 100n) return;
    const cv = (b.collateral * b.price) / 100n; const target = (cv * 75n) / 100n;
    if (target >= b.debt) return;
    let repay = b.debt - target; let seize = ((repay * 105n) / 100n * 100n + b.price - 1n) / b.price;
    if (seize > b.collateral) { seize = b.collateral; repay = b.debt; }
    accrue(); b.debt -= repay; b.collateral -= seize; b.liq++;
  };
  act();
  for (const p of path) { b.now += INTERVAL; b.price = BigInt(p * 100); act(); check(); }
  b.now += INTERVAL; accrue();
  return {
    survived: b.liq === 0,
    continuity: Number((b.debtTime * 10_000n) / (START.debt * b.now)) / 100,
    veth: Number(START.freeVeth - b.freeVeth) / 100,
    vusd: Number(START.freeVusd - b.freeVusd) / 100,
    ops: b.ops,
  };
};

console.log("scenario            survived  continuity   vETH used   vUSD used   actions");
for (const [name, path] of Object.entries(SCENARIOS)) {
  const r = run(path);
  console.log(`${name.padEnd(20)}${(r.survived ? "yes" : "NO ").padEnd(10)}${r.continuity.toFixed(2).padStart(7)}%   ${r.veth.toFixed(2).padStart(6)}      ${r.vusd.toFixed(2).padStart(8)}   ${r.ops}`);
}

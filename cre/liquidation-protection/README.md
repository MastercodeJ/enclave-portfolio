# Liquidation protection — CRE Confidential Workflow

Protects a vETH-collateral / vUSD-debt position on the challenge's
`ChallengeLending` contract. Policy and wallet key are Vault DON secrets; the
position is read, the decision made and the transaction signed inside a Nitro
enclave.

## The strategy

Two facts from the contract shape it. Deposits do not change debt, so they cost
nothing in loan continuity. And liquidation only fires when the admin calls
`checkAllHF()` — a separate transaction from the price update, at a time you do
not know.

**Layer 1 — buffer.** On `ChallengeStarted`, deposit enough collateral that the
position survives down to a secret floor price with debt untouched. One
transaction, before any price moves, no race.

**Layer 2 — reactive.** On every `PriceUpdate`, recompute HF exactly as the
contract does. If it is under the secret trigger: top up collateral to the
secret target, capped; if vETH is exhausted, repay within a secret cap; if even
that cannot keep HF above 100, repay whatever it takes. A secret cooldown
suppresses non-critical top-ups. A slow cron backstops missed logs.

`bun run check` replays the five published scenarios and harsher ones against
the policy in `cre/.env`:

```
scenario            survived  continuity   vETH used   vUSD used   actions
gradual-decline     yes        100.00%       2.27          0.00   1
sudden-crash        yes        100.00%       2.27          0.00   1
temporary-wick      yes        100.00%       2.27          0.00   1
two-stage           yes        100.00%       2.27          0.00   1
safe-volatility     yes        100.00%       2.27          0.00   1
harsh: to 1150      yes        100.00%       3.82          0.00   2
harsh: to 850       yes         97.25%       5.00        770.00   4
```

## Files

```
main.ts          triggers (log: ChallengeStarted|PriceUpdate; cron), RPC over
                 confidential HTTP, signing inside the enclave
policy.ts        the decision, as pure integer math
policy.test.ts   a bit-exact model of ChallengeLending; all scenarios
check.ts         replay your real policy (from cre/.env) — never the repo's
config.staging.json     our private copy of the contracts
config.production.json  the official challenge contract
```

## Confidentiality

| Requirement | How |
|---|---|
| Trigger / target HF private | in the `LIQUIDATION_POLICY` secret only |
| Capital limits / action policy private | same secret; priority is code, thresholds are secret |
| Credentials as protected secrets | key is a Vault DON secret, signs inside the enclave |
| Nothing private in logs, errors, config | three log lines, all coarse; validation errors name the field, never the value; configs hold only addresses, RPC and schedule |
| Execution evidence | simulator TEE banner; DON execution receipt once deployed |

Pick policy values that appear nowhere in this repository. The tests and
`.env.example` are public.

## Deploy

```bash
cre secrets create ../secrets.yaml --target production-settings --secrets-auth=browser
cre workflow deploy ./liquidation-protection --target production-settings
cre workflow list --registry private
```

Requires Chainlink deploy access and Confidential Workflows access. The
workflow must be live on the DON when the scenarios are run after the deadline.

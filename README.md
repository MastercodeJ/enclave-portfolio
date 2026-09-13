<p align="center"><img src="assets/logo-512.png" width="128" alt="Enclave Portfolio"></p>

# Enclave Portfolio — ETHOnline 2026, Chainlink CRE

Two Chainlink CRE **Confidential Workflows**. In both, the strategy is a secret
decrypted only inside an AWS Nitro enclave; what leaves the enclave is a signed
transaction and a one-word status.

| Workflow | Prize | What it does |
|---|---|---|
| [`cre/confidential-rebalancer`](cre/confidential-rebalancer) | Best Confidential Workflow | A portfolio-construction engine. The user's portfolio *design* — assets, base allocation, signals, constraints, policy — is one secret spec. Targets are composed inside the enclave from live prices, so there is no fixed target for an observer to recover from the trades. |
| [`cre/liquidation-protection`](cre/liquidation-protection) | Automated Liquidation Protection Challenge | Protects a vETH/vUSD position on `ChallengeLending`. A pre-emptive collateral buffer at `start()` plus a reactive layer on every `PriceUpdate`, both driven by a secret policy, both signed inside the enclave. |

Everything below runs in `cre/`. The Python code at the root is an earlier
Hedera prototype (see [`docs/hedera-prototype.md`](docs/hedera-prototype.md))
whose strategy layer inspired the spec validator; it is not part of the
submission.

## Why an enclave

A strategy that is automated has to live somewhere. In a bot, the host can read
it. In a contract, everyone can. In a Chainlink node's config, every operator
can. Confidential Workflows put it in hardware-isolated memory that the node
operator running it physically cannot inspect, and release the secrets only to
an attested binary — so a front-runner cannot learn what the workflow will do
until it has done it.

Delete the TEE handler from either workflow and there is no decision left to
make. The enclave is the decision engine, not a feature.

## Quick start

```bash
# prerequisites: bun 1.4+, cre CLI 1.32+, cre login
cd cre && cp .env.example .env            # then edit: your secrets go here

# confidential rebalancer
cd confidential-rebalancer && bun install && bun test        # 80 tests
bun run mock:server &                                        # portfolio/price fixtures
bun run trace                                                # every stage of one cycle, in clear
cd .. && cre workflow simulate ./confidential-rebalancer --target=staging-settings --trigger-index=0

# liquidation protection
cd liquidation-protection && bun install && bun test         # 22 tests, contract-faithful simulator
bun run check                                                # your policy vs. every scenario
cd .. && cre workflow simulate ./liquidation-protection --target=staging-settings --trigger-index=1 --non-interactive
```

The simulator prints the TEE registration:

```
│ Trigger requested TEE Execution your trigger will run in one of the following Tees:
│     - AWS Nitro in us-west-2
│ During real execution, user logs for this trigger will not be visible, and will not leave the TEE.
```

## What is confidential, precisely

| | Rebalancer | Liquidation protection |
|---|---|---|
| **Secret** | The portfolio spec: universe, base weights, signal types + strengths + lookbacks, per-asset bounds, drift band, trade cap, impact cap | Floor price, HF trigger, HF target, deposit cap, repay cap, cooldown, wallet key |
| **Computed inside, never emitted** | Target weights, drift, uncapped deltas, volatility, which legs were dropped | HF, required collateral, the deposit/repay split |
| **Public** | The trades (token, side, size), the source code | The transaction, its amount, the source code |
| **Logged** | `rebalance-executed legs=2` / `rebalance-skip reason=<word>` | `held reason=<word>` / `acted kind=<deposit\|repay> tx=<hash>` |

Source code is public — Chainlink's docs are explicit that the enclave protects
data, not logic. Both workflows therefore keep *parameters* secret and make the
*derived values* unrecoverable: the rebalancer by composing moving targets, the
protection workflow by acting before the price moves.

## Test harness for the challenge

`cre/challenge-contracts` is a private copy of the challenge's three contracts,
deployed on Sepolia with our wallet as admin, so the scenarios can be run by us:

```bash
cd cre/challenge-contracts
script/deploy.sh                 # fresh copy (a started scenario cannot reset)
script/scenario.sh join && script/scenario.sh start
script/scenario.sh run sudden-crash     # steps the price; workflow reacts in between
```

The offline simulator in `liquidation-protection/policy.test.ts` models
`ChallengeLending` bit for bit (integer HF, partial liquidation, time-weighted
debt) and is what `bun run check` runs your real policy through.

## Numeric policy

No float touches money. Token amounts are `bigint` base units; USD is
fixed-point 1e8; weights and health factors are integer basis points computed
exactly as the contracts compute them. Every division truncates, never in the
trader's favour. Every parser refuses rather than guesses.

## Status and evidence

- Rebalancer: 80/80 tests, simulator `EXECUTED` through the Nitro path
- Liquidation protection: 22/22 tests; live test on the private Sepolia copy —
  price dropped to $1,500 (hf 100), enclave signed `deposit()`, hf 116,
  `checkAllHF()` liquidated nothing, debt untouched
- Official challenge: joined, both tokens approved (`0xBe23…C783`)
- Deployment to the DON: pending Chainlink deploy + Confidential Workflows access

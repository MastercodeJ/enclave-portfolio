# Confidential Rebalancer — Chainlink CRE workflow

DeFi Copilot's strategy engine, moved inside a hardware enclave.

The portfolio is public. The swaps are public. **The strategy is not.** Target
weights, the drift band that triggers a rebalance, the per-trade cap and the
price-impact ceiling are Vault DON secrets, decrypted only inside an AWS Nitro
enclave and never returned to the Workflow DON.

An observer of the chain sees *that* a rebalance happened and *what* was
swapped. They cannot recover *why* — which is the whole of the alpha.

## Why this needs a TEE

Without confidential execution the target weights have to live somewhere a node
operator can read: in workflow config, in a contract, or in plaintext on the
node running the strategy. Any of those publishes the strategy to whoever
operates the infrastructure. A copier who knows the weights and the drift band
can front-run every rebalance this workflow will ever emit.

Delete the TEE handler and there is no strategy left to run — no weights, no
drift check, no sizing. The enclave is not a feature of this product, it is the
decision engine.

## What crosses the boundary

| Stays inside the enclave | Crosses back to the DON |
|---|---|
| Base allocation (bps) | The trade list: token, side, notional |
| **Derived target weights** | `min_amount_out` per leg |
| Volatility tilt strength, lookback | Leg count |
| Weight bounds | `EXECUTED` / `NOOP` |
| Drift threshold | |
| Max trade size, max price impact | |
| Portfolio valuation, weights, drift | |
| Volatility estimates, quote responses | |

`runtime.log` output is visible outside the enclave, so log lines carry only
counts, token ids and coarse status words — never a drift figure, weight or
threshold, each of which is secret-derived.

The price-impact check runs *inside* the enclave for the same reason. Emitting
`maxPriceImpactBps` with each trade and letting the executor enforce it would
publish the cap; enforcing it here means the outside world receives only a
`min_amount_out`, which it needs to execute anyway.

## Numeric policy

Token amounts are integers in base units, carried as `bigint`, and never
converted to `number`. A float64 loses precision above 2^53 — about 90M HBAR at
8 decimals, and far less headroom for an 18-decimal ERC-20.

USD values are fixed-point `bigint` at 1e8 (`_e8`). Weights and drifts are
basis points (`_bps`). Every division truncates toward zero, so a position is
never overstated and a quote never promises more output than the pool gives.

This is a deliberate departure from Chainlink's stock rebalancing template,
which uses float `number` for holdings, prices and notionals throughout.

## Layout

```
cre/
├── project.yaml                  CRE targets and RPCs
├── secrets.yaml                  secret id -> env var mapping (two secrets)
├── .env.example                  the portfolio spec, for local simulation
└── confidential-rebalancer/
    ├── main.ts                   the workflow: TEE handler, valuation, sizing
    ├── portfolio.ts              THE PORTFOLIO LAYER: spec parsing + composition
    ├── signals/                  pluggable signal blocks
    │   ├── inverse_volatility.ts   risk-parity tilt
    │   ├── momentum.ts             trailing-return tilt
    │   ├── equal_weight.ts         diversification pull
    │   └── index.ts                registry: type name -> block
    ├── signal.ts                 fixed-point math primitives
    ├── numeric.ts                refuse-don't-guess parsers
    ├── trace.ts                  prints every stage of one cycle
    ├── mock-server.js            portfolio / prices / history / quote / execute
    ├── *.test.ts                 80 tests
    ├── config.staging.json       schedule, service URL, account, secret ids
    └── workflow.yaml             workflow name and artifact paths
```

## Setup

Prerequisites (already installed on this machine):

```bash
curl -fsSL https://bun.sh/install | bash            # bun 1.4.2
curl -sSL https://app.chain.link/cre/install.sh | bash   # cre v1.32.0
```

Then:

```bash
cd cre/confidential-rebalancer && bun install
cp ../.env.example ../.env      # edit: this file is your strategy
cre login                       # interactive, one time
```

## Run

```bash
# terminal 1 — the portfolio/price/quote service
cd cre/confidential-rebalancer
set -a && . ../.env && set +a
bun mock-server.js

# terminal 2 — checks, then the enclave simulation
cd cre/confidential-rebalancer
bun run typecheck
bun test
cd .. && cre workflow simulate ./confidential-rebalancer \
    --target=staging-settings --trigger-index=0 --engine-logs
```

## The portfolio layer

The entire strategy is **one secret**: a PortfolioSpec.

```json
{
  "universe": ["0.0.15058", "0.0.5449", "0.0.1183558"],
  "quote": "0.0.5449",
  "base": { "0.0.15058": 5000, "0.0.5449": 3000, "0.0.1183558": 2000 },
  "signals": [
    { "type": "inverse_volatility", "strength": 6000, "lookback": 20 }
  ],
  "constraints": { "min_weight": 500, "max_weight": 6000 },
  "policy": { "drift_threshold": 500, "max_trade": 2000, "max_price_impact": 100 }
}
```

| Section | Question it answers |
|---|---|
| `universe` | What may I hold? |
| `base` | What is my strategic view? |
| `signals` | How does the market tilt that view, and by how much? |
| `constraints` | What must never happen? (global + per-asset bounds) |
| `policy` | When and how do I act? |

Composition is a convex combination — each signal's `strength` is the share
of the final target it decides, the remainder stays with the base view — then
per-asset bounds are applied by water-filling and the vector is forced to sum
to exactly 10000 bps.

Two users on the same deployed workflow can run entirely different portfolios
built entirely different ways. The public code reveals only that a spec is
evaluated: not which assets, which signals, or how they are weighted.

Signal blocks are pluggable (`signals/`). Adding one is: write it, register it.
`equal_weight` + `inverse_volatility` gives pure risk parity; a spec with no
signals is the static-weights rebalancer, preserved as a special case.

### Why derived targets matter for privacy

A fixed target is recoverable: a rebalance moves the book *toward* it, so an
observer reading balances before and after can solve for it. One uncapped
rebalance can be enough.

A composed target is not, because the same book produces different targets as
volatility and momentum move, and the observer cannot see the strengths,
lookbacks or bounds that map one to the other. Combined with the per-trade
cap — which stops any single rebalance fully closing the gap — the post-trade
weights are neither the target nor a fixed point to converge on.

## The scenario the mock serves

A $10,000 book sitting at 62 / 25 / 13, with per-period volatility of 3% for
WHBAR, 0.05% for USDC and 8% for SAUCE:

| Token | Held | Value | Current | Base | Derived target |
|---|---|---|---|---|---|
| WHBAR `0.0.15058` | 124,000 | $6,200 | 62% | 50% | **~26%** |
| USDC `0.0.5449` | 2,500 | $2,500 | 25% | 30% | **~60%** (capped) |
| SAUCE `0.0.1183558` | 130,000 | $1,300 | 13% | 20% | **~14%** |

Risk parity pushes weight toward the calm asset and away from the volatile one,
so USDC is pulled up into its 6000 bps ceiling while SAUCE — the riskiest — is
cut below its base weight. Output:

```
SELL WHBAR $2,000.00   <- hits the 20% per-trade cap; gap stays open
BUY  SAUCE $    99.00
```

Compare against `VOL_TILT_BPS=0`, which gives the untilted `sell $1,200 WHBAR,
buy $700 SAUCE`. Same book, same portfolio, different market view.

Note the WHBAR leg hit the cap. It does **not** reach target this cycle, which
is precisely what stops an observer reading the target off the result.

Things to try in `.env`:

| Change | Effect |
|---|---|
| `REBALANCER_VOL_TILT_BPS=0` | pure base weights, no signal |
| `REBALANCER_VOL_TILT_BPS=10000` | full risk parity |
| `REBALANCER_MAX_PRICE_IMPACT_BPS=50` | drops the SAUCE leg on impact |
| `REBALANCER_MAX_TRADE_BPS=500` | every leg partial, slowest information leak |
| `REBALANCER_MAX_WEIGHT_BPS=4000` | tighter cap on the calm-asset concentration |

## Going live

`portfolio_base_url` in `config.staging.json` is the only thing standing
between this and the real portfolio. The mock speaks the shapes the Hedera
service already produces:

| Endpoint | Backed by |
|---|---|
| `GET /portfolio/:id` | `src/portfolio/balance.py` (mirror node) |
| `GET /prices` | `src/market/prices.py` (SaucerSwap pool state) |
| `POST /quote` | `src/market/quotes.py` |
| `POST /execute-rebalance` | not yet built — the remaining work |

## Known gaps

- `quant:` the mock's price impact is a linear `notional / depth` proxy, not a
  real curve. Production impact comes from `src/market/quotes.py`, which
  computes exact constant-product output.
- `quant:` a capped leg converges partially across cron ticks by design. There
  is no guard yet against a portfolio that oscillates because the cap is small
  relative to the drift band.
- Confidential Workflows deployment is invite-only private beta. Local
  simulation needs only `cre login`.
- The on-chain audit log (CRE → EVM write) is not wired yet. It is what would
  qualify the project for the Continuity Track upgrade prize.

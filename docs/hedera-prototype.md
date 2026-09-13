# DeFi Copilot

An autonomous portfolio rebalancer for Hedera. It watches token prices, and
when a portfolio drifts from its target weights, it executes the swaps needed
to bring it back — under risk limits enforced in code, with every decision
written to an immutable on-chain audit log.

Built for **ETHOnline 2026**, Hedera track: *AI & Agentic Payments*.

> **Status:** in progress. Portfolio reads and market data are complete and
> tested against live testnet. Swaps and strategy are not built yet — see
> [Roadmap](#roadmap).

---

## What works today

`get_account_balance()` reads any Hedera account's holdings — HBAR plus every
fungible HTS token, with symbols resolved, amounts scaled by their decimals,
and NFTs filtered out.

```python
import asyncio
from src.portfolio import get_account_balance

balance = asyncio.run(get_account_balance("0.0.1027"))
print(balance)
```

```
0.0.1027 on testnet — 36.46199249 HBAR
  USDC         45.610999
```

It accepts either address form — `0.0.1027` or
`0x0000000000000000000000000000000000000403` resolve to the same account.

Reads go through the Hedera **mirror node REST API**, which is free, public and
unauthenticated. No operator key, no gas, no SDK — you can run the above
against live testnet without creating an account first.

The same capability is exposed to an LLM as a Hedera Agent Kit tool:

```python
from hedera_agent_kit.shared.configuration import Context
from src.plugins.portfolio_plugin import build_portfolio_plugin

plugin = build_portfolio_plugin(network="testnet")   # -> get_portfolio_balance_tool
```

It's a read-only tool — no transaction, no operator key — so it is safe in
every `AgentMode`, including `RETURN_BYTES`.

## Market data

`src/market/` prices tokens and quotes swaps from SaucerSwap pool state.

```python
from decimal import Decimal
from src.market import get_pools, get_price, get_quote

pools = await get_pools()                       # quality-filtered
await get_price("0.0.1183558", pools=pools)     # SAUCE = 0.01719 HBAR ($0.001264)
await get_quote("0.0.15058", "0.0.1183558", Decimal("100"), pools=pools)
# 100 -> 5764.039055 (impact 0.433%, fee 0.30%, v1 0.0.2656382)
```

Prices are computed from pool state rather than read from SaucerSwap's
precomputed `priceUsd`, so a price and a quote always describe the same pool —
they can never disagree. Both formulas are cross-checked against the API's own
figures in the live tests.

| | V1 (constant product) | V2 (concentrated liquidity) |
|---|---|---|
| Spot | reserve ratio | `(sqrtRatioX96 / 2^96)^2` |
| Quote | exact | **approximate** — see below |
| Testnet pools | 580 | 20 |

### Things that cost time to discover

- **SaucerSwap V1 ≈ Uniswap V2; SaucerSwap V2 ≈ Uniswap V3.** The names are off
  by one. Check which lineage any doc or plugin means.
- **No websocket and no quote endpoint.** All `wss://` variants 404, as do
  `/quote`, `/swap/quote` and `/router/quote`. Prices are polled and quotes
  computed locally. The rate limit header reports 10,000,000, so polling is
  effectively unmetered; a 10s cache keeps one rebalance cycle consistent.
- **V2 tick data is always empty**, on every endpoint. So a V2 quote assumes
  constant liquidity across the trade — fine inside the current tick, worse as
  the trade grows. Every V2 quote carries `approximate=True`, and V1 is
  preferred unless a V2 pool is more than twice as deep.
- **Four testnet tokens call themselves "HBAR".** `0.0.0` (native sentinel),
  `0.0.15058` (WHBAR, what pools actually trade) and `0.0.2230359` are one
  asset; `0.0.8647814` is **not** — it prices differently. Aliasing is resolved
  in `src/config.py:HBAR_ALIASES`, once, so HBAR is never double-counted.
- **Junk pools outrank real ones by TVL.** The largest testnet pool by computed
  TVL is a fabricated `CTK/LTK` pair claiming **$5.9 billion**, while
  SaucerSwap's own `/stats` puts the entire network at ~$683,000. `get_pools()`
  filters on due diligence, non-zero price and real liquidity by default —
  600 pools become 27.
- **Testnet prices are fiction.** Testnet "USDC" trades near $0.033, not $1.
  Structurally correct, economically meaningless. Never present it as market
  data.

### Safety guarantees

The quote path refuses rather than guesses, because a confident wrong number is
worse than an error for something that sizes real swaps:

| Condition | Behaviour |
|---|---|
| `amount_in` zero or negative | `ValueError` — negative input used to return a *large positive* output |
| Output exceeds the pool's reserves | `InsufficientLiquidityError` — V2's single-tick maths would otherwise quote more than exists at ~4% reported impact |
| Pool returns zero output | `NonViableQuoteError` |
| Selected pool is malformed | falls through to the next-best pool |
| Most pools unparseable | `MarketDataError` — never a silent empty list |
| Token has no priceable pool | `None`, never zero |

Rounding floors, matching Solidity integer division exactly — verified against
Uniswap V2's `getAmountOut` to the raw unit at every trade size. Rounding
half-even instead overstates output by up to one unit, enough to make an
on-chain swap revert against a `min_amount_out` derived from our own quote.

Fee-on-transfer tokens are excluded from quality pools: they deliver less than
the AMM computes and the pool data does not say how much less, so the amount
cannot be corrected for.

## Strategy

`src/strategy/` turns what a user says into a validated, executable target.

```python
from src.strategy import parse_strategy

strategy, problems = await parse_strategy(
    "Keep me 50/30/20 HBAR USDC SAUCE, rebalance weekly, "
    "never trade more than 20% at once"
)
```

```
Strategy:
  HBAR         50%   [0.0.15058]
  USDC         30%   [0.0.5449]
  SAUCE        20%   [0.0.1183558]
  rebalance weekly when drift exceeds 5%
  limits: max 20% per trade, max 1% price impact
```

Either `strategy` is valid, or it is `None` and `problems` says exactly why.

### Why this is a layer and not just a prompt

The parsing is nearly free — one `with_structured_output` call. The layer earns
its place for three other reasons:

- **A strategy outlives its conversation.** When a scheduled rebalance fires
  with nobody watching, there is no chat context to re-read. Something must
  have persisted `{HBAR: 0.5, USDC: 0.5}` as data.
- **Policies enforce numbers, not sentences.** Risk limits are checked below
  the model, where an LLM cannot talk its way past them. A hook can read
  `strategy.max_trade_pct`; it cannot read "the user said don't trade too much."
- **Symbols get pinned exactly once.** Users speak in symbols, and six testnet
  tokens are called "USDC". `src/config.py:resolve_symbol` is the only
  sanctioned lookup; everything downstream uses IDs.

### Nothing is silently repaired

The strategy belongs to the user, so `33/33/33` is rejected with *"percentages
add up to 99%, not 100%"* rather than being quietly rescaled. Every problem
carries a field, a reason and a suggestion, and they accumulate — so a repair
prompt can fix them all in one round trip.

Validation runs against **live pool data**, so a plausible-sounding but
untradable token fails with *"DOGE is not a token we can trade on testnet"*
instead of slipping through. That is the main failure mode of LLM extraction.

### Testable without an LLM

`extract.py` is the only module that touches a language model, and it imports
`langchain` lazily. Pass an `extractor` and the model is bypassed entirely:

```python
strategy, problems = await parse_strategy("half and half", extractor=my_stub)
```

All 41 strategy unit tests run with no API key and no network.

## Web app

```bash
pip install -e ".[web]"
python run.py            # -> http://localhost:8000
```

A single page: type a strategy, see it validated, inspect holdings and live
prices. **It works before any LLM key is configured** — the prompt box disables
itself and a manual allocation builder takes over, running the exact same
validation.

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Config status; the page uses `llm_configured` to adapt |
| `GET /api/tokens` | Tradable universe with live prices |
| `POST /api/strategy/parse` | Prompt → validated strategy (needs an LLM) |
| `POST /api/strategy/validate` | Manual allocation → validated strategy (no LLM) |
| `GET /api/portfolio/{address}` | Holdings, free and keyless |
| `GET /api/pools` | Quality-filtered pools, deepest first |

An invalid strategy is a **200 with `ok: false`** and a problem list, not an
HTTP error — a rejected strategy is a normal outcome, and the page renders each
problem with its field and suggestion. Failures that genuinely are errors map
properly: unknown account → 404, mirror node trouble → 502, missing credentials
→ 400 with text saying which variable to set.

### Wallet approval by QR

Nobody edits a config file. The LLM key is pasted into the page (operator
config), and the user connects a wallet by scanning a QR (user identity) —
two different concerns, two different people.

```
scan QR  ->  HashPack pairs over WalletConnect (HIP-820)
         ->  server builds an UNSIGNED allowance transaction
         ->  hedera_signAndExecuteTransaction sends it to the wallet
         ->  user approves; the agent may now spend within the caps
```

The server never sees a private key. It builds an
`AccountAllowanceApproveTransaction` with the **user** as payer, and the wallet
signs it.

**One protocol detail that costs an afternoon if missed:** HIP-820's
`hedera_signAndExecuteTransaction` takes a base64 **`TransactionList`**, but the
SDK's `to_bytes()` returns a bare **`Transaction`** (field 5 vs field 1). The
Python SDK does not generate `TransactionList`, so
`src/wallet/allowance.py:wrap_transaction_list` encodes the single-element case
by hand. A test asserts both protobuf tags.

**And the honest caveat:** allowances authorise *transfers*, not swaps.
SaucerSwap's router pulls from `msg.sender`, which is the agent — so the agent
must pull the user's tokens in, swap, and send the proceeds back. Keys never
leave the wallet and the allowance is capped and revocable, but the agent does
briefly hold the funds. This is stated on the page itself, not just here.

**Setup:** a free WalletConnect project id from
[cloud.reown.com](https://cloud.reown.com), pasted into the page. Note that in
a real deployment the agent needs its **own** account — right now
`HEDERA_OPERATOR_ID` is the same account you would be connecting, and an
account cannot hold an allowance over itself.

## Configuration: who provides what

Three credentials, three different owners. Only one of them is a private key,
and it is never a user's.

| What | Whose | Where it goes | Why |
|---|---|---|---|
| **User's wallet** | the end user | nowhere — QR only | They sign in HashPack. Asking a user for a private key would be a design failure. |
| **Agent's operator key** | you, the operator | pasted in the page, or `python scripts/setup.py` | The agent signs autonomously with nobody present, so a key must be on the machine. |
| **LLM key** | you, the operator | pasted into the page | Inference is billed to whoever runs the service. |
| **WalletConnect project id** | you, the operator | pasted into the page | Not a secret: it ships to every browser anyway. |

```bash
python scripts/setup.py     # the agent's account — the only key on disk
python run.py               # then paste the LLM key and project id in the page
```

### Proving the operator key before accepting it

The agent's key is verified by **deriving its public key and comparing it to
the account's on-chain record** — no transaction, no fee, and a wrong key is
caught immediately instead of failing at the first swap.

One subtlety makes this necessary rather than decorative:
`PrivateKey.from_string` cannot reliably distinguish a 32-byte ECDSA key from
an Ed25519 seed, and it guessed wrong on a real account here — silently
deriving a public key that matched nothing. So the key type is read from the
account record and the matching loader is used explicitly. A test asserts it.

Handling, because this one controls funds:

- **Localhost only** — the routes return 403 to any remote caller.
- Never returned (only a masked tail), never logged, cleared from the DOM on save.
- `.env` is written `chmod 600` and is gitignored.
- ED25519 accounts and low balances are accepted with a warning, not silently.

`scripts/setup.py` does the same from a terminal, reading the key with
`getpass` so it never reaches shell history.

## Quick start

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

pytest -q          # 154 unit tests, mocked, no network, no LLM
pytest -q -m live  # 27 integration tests, real testnet
```

The LLM-facing tool wrapper needs the Agent Kit, which is a heavy install
(~150 transitive packages — it pins `google-adk` and `web3`, pulling in the
Google Cloud SDK, LangChain, LangGraph, OpenAI and Anthropic clients):

```bash
pip install -e ".[agent]"
```

That weight is exactly why the core module doesn't depend on it. Plugin tests
skip automatically when the kit is absent.

## Architecture

```
src/portfolio/  ┐
src/market/     ├─ pure async functions — httpx only, no kit, no SDK
src/strategy/   ┘  (strategy's LLM import is lazy and injectable)
      ▲
src/plugins/       thin Hedera Agent Kit tool wrappers
```

The dependency arrow points one way on purpose. The core module knows nothing
about the Agent Kit, so portfolio logic stays testable without an LLM, without
credentials, and without the kit's dependency tree. The plugin layer only
translates between the kit's `Tool` interface and those functions.

| Module | Responsibility |
|---|---|
| `src/config.py` | Network → mirror node host mapping |
| `src/portfolio/models.py` | `AccountBalance`, `TokenBalance` value objects |
| `src/portfolio/mirror_client.py` | HTTP: pagination, retries, typed errors |
| `src/portfolio/balance.py` | `get_account_balance()` |
| `src/plugins/portfolio_plugin.py` | Agent Kit tool exposing the above to an LLM |
| `src/market/client.py` | SaucerSwap HTTP: retries, short TTL cache |
| `src/market/pools.py` | Pool parsing, quality filter, pool selection |
| `src/market/prices.py` | Spot prices from reserves / `sqrtRatioX96` |
| `src/market/quotes.py` | Swap quotes with fee and price impact |
| `src/strategy/models.py` | `StrategyDraft` (untrusted) and `Strategy` (validated) |
| `src/strategy/validate.py` | Draft → Strategy, or specific reasons why not |
| `src/strategy/extract.py` | The only LLM-touching module; import is lazy |
| `src/strategy/store.py` | JSON persistence, exact `Decimal` round-trip |
| `src/formatting.py` | Shared display trimming for `Decimal` |
| `src/api/app.py` | FastAPI routes; a thin adapter with no logic of its own |
| `src/api/config_routes.py` | Runtime LLM key and WalletConnect project id |
| `src/api/wallet_routes.py` | Builds unsigned allowance transactions |
| `src/wallet/allowance.py` | Allowance construction + `TransactionList` encoding |
| `web/` | Single-page UI; `wallet.js` handles pairing and approval |
| `tests/test_review_regressions.py` | Locks down every defect found in review |

### Design rules

- **`Decimal`, never `float`.** These are financial amounts; float rounding is
  how a rebalancer silently drifts.
- **Keep `raw_balance` beside `amount`.** Write paths need the raw integer in
  the token's smallest unit; recomputing it from a scaled Decimal invites
  off-by-one errors.
- **Filter NFTs by `type`, not `decimals == 0`.** Some fungible tokens are
  legitimately issued with zero decimals.

## Hedera specifics worth knowing

Things that cost time to discover, documented so they don't cost it twice:

- **Association is mandatory** — unless auto-association is on. An account
  cannot hold a token until it opts in via `TokenAssociateTransaction`, which a
  rebalancer buying a new asset hits constantly. Setting
  `maxAutomaticTokenAssociations` to `-1` (unlimited) removes the problem
  entirely, at the cost of rent; our operator account uses it.
- **HBAR is not an HTS token.** It's the native coin, tracked separately in
  tinybars (1 ℏ = 100,000,000 tℏ). SaucerSwap pools trade **WHBAR**, the
  wrapped form, so portfolio maths needs three cases: HBAR, WHBAR, HTS.
- **Tokens carry compliance state.** `freeze_status` and `kyc_status` can block
  a transfer outright. `TokenBalance.transferable` surfaces this — check it
  before attempting a swap rather than eating a failed transaction.
- **Symbols cost an extra call.** The account's token list returns balances and
  decimals but no symbol, name or type. Those come from `/tokens/{id}`, one per
  distinct token, fanned out concurrently and memoised.
- **`decimals` type is inconsistent.** An `int` on the account sub-resource, a
  `str` on token metadata. Both are coerced; a test asserts it never leaks.
- **Testnet resets quarterly.** Accounts, tokens and topics are wiped. Live
  tests are marked `live` and excluded from default runs for this reason.

## Roadmap

1. ~~Portfolio read~~ ✅
2. ~~Market data — DEX pool prices and swap quotes~~ ✅
3. ~~Strategy layer — user prompt to validated target~~ ✅
4. Drift calculation: portfolio × prices × strategy
5. **Testnet swap execution** — the router contract via `eth_call` + signing.
   SaucerSwap is confirmed live on testnet, so the remaining risk is signing,
   not availability
6. Risk limits as Agent Kit policies, not prompt text — the Python kit's
   `hedera_agent_kit.policies` and `AbstractHook` are confirmed present
7. HCS audit trail via `HcsAuditTrailHook` (ships with the kit)
8. Scheduled recurring rebalances
9. ~~WalletConnect QR + allowance approval~~ ✅ (untested against a real wallet)

Deferred ideas and their rationale live in [docs/backlog.md](docs/backlog.md).

## Testing

```bash
pytest -q                     # unit only; live tests deselected by default
pytest -m live                # integration against real testnet
```

Live tests assert structural invariants (`amount == raw_balance` scaled by
`decimals`) rather than hardcoded balances, so they survive balance changes —
though not a testnet reset.

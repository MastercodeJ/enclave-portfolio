# Backlog — deferred enhancements

Ideas parked deliberately, not forgotten. Nothing here blocks the core build
(portfolio read → price → drift → swap). Revisit once a Testnet swap works
end to end.

---

## HCS-14 — Universal Agent ID  *(maybe, if we have a spare hour)*

**Verdict: worth it if time allows. Dramatically cheaper than ERC-8004.**

Generate a UAID via the SDK, publish the agent's profile to an HCS topic, and
reference it in our audit-trail entries. That gives us a genuine sentence for
the README:

> "Every rebalance logged to HCS is attributable to a resolvable agent identity."

It composes naturally with the `HcsAuditTrailHook` work we're already doing,
rather than being bolted on.

**What HCS-14 is:** Hashgraph Online's standard (Draft) for a UAID — a
deterministic, protocol-neutral identifier for an agent, built on the W3C DID
framework. Dual methods: `AID` for registry-generated IDs, `UAID` for
self-sovereign ones. The pitch is portability: one identity that works across
Web2 APIs, EVM chains, and A2A, so an agent isn't re-identified in every
ecosystem. Notably it is **network-agnostic** — Hedera support is optional,
despite the name.

**Why it's cheap:** no contracts to deploy. SDK call to mint the identifier,
one HCS topic message to publish the profile, one field added to each audit
entry.

**Prize relevance:** Track 1 lists "on-chain agent identity via ERC-8004 or
HCS-14" as an optional enhancement.

**Priority:** below the Testnet swap, the policy engine, and x402. An identity
for an agent that can't yet trade is the wrong order.

- Standard: https://hol.org/docs/standards/hcs-14/
- Announcement: https://hol.org/blog/hcs-14-universal-agent-ids
- HCS standards index: https://hashgraphonline.com/docs/standards/

---

## Scheduled / recurring payments via Hedera Scheduled Transactions

**Verdict: likely in scope. Highest-value optional enhancement after x402.**

A rebalancer that only acts when you poke it is a script. One that rebalances
*on a schedule*, natively, with no bot or keeper, is a product — and Hedera's
Schedule Service is the differentiator the sponsor keeps pointing at across
four of the five tracks.

**Shape:** "Rebalance my portfolio every Friday at 09:00" → a scheduled
transaction created now, executed by the network later. No cron, no watcher
process, no server that has to stay up. That last point is the demo line:
*the automation survives our laptop closing.*

### What a scheduled transaction actually is

Build a transaction, then hand it to the **network to hold** rather than
submitting it for immediate execution. It gets its own `ScheduleId` (e.g.
`0.0.12345`) and waits until its execution condition is met, at which point the
network runs it with no involvement from us. The ledger is the scheduler.

**Two ways it fires:**

1. **When signatures are collected** (default). Submit a transaction needing
   more signatures than we hold; others add theirs later via
   `ScheduleSignTransaction`; it executes the moment the required set is
   complete. Native multi-sig, no multi-sig contract.
2. **At a set time** — `set_wait_for_expiry(True)` + `set_expiration_time(...)`.
   Waits on the clock instead of the signatures: even if every signature
   arrives early, it holds until expiry. **This is our "scheduled payment".**
   Execution happens at the earliest consensus time after `expiration_time`,
   best-effort.

**Limit:** transactions can be queued up to **~2 months** into the future
(HIP-423).

### ⚠️ Recurring is NOT native

Hedera schedules are **one-shot**. There is no cron expression, no "every
Friday" field.

To get recurring behaviour we **re-schedule after each execution**: when
rebalance N fires, the agent creates the schedule for N+1. This works, and the
demo looks identical — but it means the agent must be alive at least once per
interval to arm the next one.

**Consequence for the README:** the honest claim is "the automation survives
our laptop closing *between* rebalances", not "forever". Still a strong story;
just don't overstate it in the demo video.

### Verified support

`hiero-sdk-python` **0.2.0** (already installed) exposes:

- `ScheduleCreateTransaction` — setters include `set_scheduled_transaction`,
  `set_expiration_time`, `set_wait_for_expiry`, `set_admin_key`,
  `set_payer_account_id`, `set_schedule_memo`
- `ScheduleSignTransaction`, `ScheduleDeleteTransaction`
- `ScheduleId`, `ScheduleInfo`, `ScheduleInfoQuery`

**Agent Kit:** scheduling is **not a separate tool** — it's a modifier on
existing transaction tools. The docs show prompts like *"Schedule transfer 100
ERC20 tokens… make it expire 01.02.2026 and wait for its expiration time before
executing."* Core exposes only `sign_schedule_transaction_tool` and
`schedule_delete_tool` (both in `core_account_plugin`) for post-creation
management. If the modifier doesn't cover what we need, drop to
`ScheduleCreateTransaction` directly.

Multi-sig approval flows fall out of this for free — a scheduled transaction
can wait for additional signatures before executing.

**Prize relevance:** "Scheduled or recurring payments" is listed under Track 1
optional enhancements. It is *also* the core requirement of Track 4
(Cross-Chain Automation, $2,000) and Track 5 (Autonomous Automation Platform,
$1,000) — so this work is potentially reusable across three submissions.

- Docs: https://docs.hedera.com/hedera/sdks-and-apis/sdks/schedule-transaction
- Concept: https://docs.hedera.com/learn/core-concepts/transactions/scheduled
- HIP-423 (long-term schedules, 2-month window): https://hips.hedera.com/HIP/hip-423.html
- HIP-423 explainer: https://hedera.com/blog/introducing-hip-423-long-term-scheduled-transactions
- Tutorial: https://github.com/hedera-dev/devday-tutorial-hello-scheduled-world
- Template: https://github.com/hedera-dev/scaffold-hbar/tree/templates/payments-scheduler

---

## Token creation, custom fee schedules, royalty flows (HTS)

**Verdict: in scope, and useful before it is impressive.**

Two distinct reasons to do this, worth separating:

**1. Practical — we need something to trade.** Testnet resets quarterly and
token liquidity is thin. Minting our own fungible test tokens gives the demo a
deterministic portfolio to rebalance instead of depending on whatever happens
to exist on Testnet that week. This should be part of the idempotent bootstrap
script regardless of whether we pursue the bonus.

**2. Bonus — fee-bearing portfolio mechanics.** HTS supports custom fee
schedules natively: fixed fees, fractional fees, and royalty fees, collected by
the network on every transfer with no contract code. A management-fee story
writes itself — the copilot's own token charges a fractional fee on transfer,
routed to a treasury account. That is a real product mechanic, not a checkbox.

**Implementation notes:**
- Agent Kit tools: `create_fungible_token_tool`, `mint_fungible_token_tool`,
  `update_token_tool`, `associate_token_tool`.
- **To verify:** whether the kit's create tool exposes custom fee schedules. If
  not, drop to `hiero-sdk-python`'s `TokenCreateTransaction`, which does.
- Compliance controls (freeze, KYC, pause) are absent from the kit's tool list
  entirely — SDK only if we want them.
- Our `TokenBalance` model already surfaces `frozen` / `kyc_revoked`, so the
  read side is ready for fee-bearing and gated tokens.

**Prize relevance:** "HTS token creation with custom fees or royalties" is a
Track 1 optional enhancement, and it is the entire premise of Track 2
(Tokenization, $3,000) — another cross-submission reuse.

- HTS docs: https://docs.hedera.com/hedera/sdks-and-apis/sdks/token-service

---

## Hedera CLI for agent workflow automation

**Verdict: adopt for the bootstrap script. Cheapest item on this list.**

`@hashgraph/hedera-cli` v0.9.0 — "CLI tool to manage and setup developer
environments for Hedera Hashgraph." It's a Node package, but that's irrelevant:
it's a binary we shell out to, so it coexists fine with a Python project.

**Why it earns its place:** testnet resets quarterly and wipes every account,
token and topic we create. Doing setup by hand means redoing it by hand — and
discovering at judging time that the account IDs in our README are dead. The
CLI turns setup into one idempotent, re-runnable command.

**Shape:** a `scripts/bootstrap.sh` that provisions the whole demo environment
from nothing — create/fund the operator account, create the test tokens to
rebalance between, associate them, create the HCS audit topic, and write the
resulting IDs to `.env`. Re-runnable after a reset, and it doubles as
executable documentation for judges reproducing our setup.

**Prize relevance:** "Use of the Hedera CLI for agent workflow automation" is a
Track 1 optional enhancement — and unlike most of this list, it pays for itself
in saved time rather than costing time to earn a checkbox. Do it early.

- Package: https://www.npmjs.com/package/@hashgraph/hedera-cli

---

## Also deferred

**x402 — pay-per-request** *(the strongest optional add)*
Gate the strategy-signal endpoint behind HTTP 402 so the copilot pays per
market-data query. Explicitly named in the track's bonus criteria, with working
reference code: [template](https://github.com/hedera-dev/scaffold-hbar/tree/templates/x402-pay-per-use),
[Hedera example](https://github.com/matevszm/x402-hedera-example), [spec](https://www.x402.org/).
Rank this **above** HCS-14.

**ERC-8004 — Trustless Agents** *(skip)*
Three on-chain registries (identity as ERC-721, reputation, validation) for
agents transacting with untrusted counterparties. We manage our owner's own
portfolio — no counterparty needs to verify us. Draft status, contract-heavy,
serves an audience of one. https://eips.ethereum.org/EIPS/eip-8004

**A2A protocol** *(skip unless we go multi-agent)*
Solves agent-to-*agent* interop; we're one agent. Using it honestly would mean
splitting into negotiating strategy/execution agents — architecture invented to
satisfy a checkbox. https://a2a-protocol.org/latest/

**OpenClaw ACP** *(blocked — ask the sponsor)*
The prize page links `docs.openclaw.ai/tools/acp-agents`, which documents
**Agent Client Protocol** — a plugin for running external *coding* tools
(Claude Code, Cursor, Codex). Nothing to do with payments. The prize copy
implies an **Agent Commerce** protocol. Likely a mislinked acronym collision.
Do not build against it without confirming in Hedera Discord.

---

## Open questions to resolve

- ~~**Python Agent Kit hooks/policies parity.**~~ **RESOLVED — the policy
  engine exists in Python 3.4.2.** Verified by introspecting the installed
  package:
  - `hedera_agent_kit.hooks` → `AbstractHook`, **`HcsAuditTrailHook`**,
    `HolAuditTrailHook`, plus all four lifecycle param types
    (`PreToolExecutionParams`, `PostParamsNormalizationParams`,
    `PostCoreActionParams`, `PostSecondaryActionParams`).
  - `hedera_agent_kit.policies` → `MaxRecipientsPolicy`, `RejectToolPolicy`.
  - Hooks attach via `Context(hooks=[...])`, same single-array design as JS —
    a policy is just a hook that can block.
  - All ten core plugins are present under `hedera_agent_kit.plugins`.

  **So the plan stands: user-defined risk limits belong in custom policies,
  not in prompt text.** Subclass `AbstractHook` for our own (max trade size,
  token allowlist, daily rebalance cap), and take `HcsAuditTrailHook` free.
- **Does `hak-saucerswap-plugin` work on Testnet?** If it's mainnet-only we
  need our own router wrapper. This is the project's #1 risk.

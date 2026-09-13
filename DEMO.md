# Enclave Portfolio — end-to-end demo runbook

Three terminals, one browser tab. Everything is real on Sepolia; nothing is
mocked. Total ~6 minutes.

## Pre-flight (5 min before)

```bash
cd cre
set -a; . ./.env; set +a
export PATH="$HOME/.cre/bin:$HOME/.bun/bin:$PATH"

# T1 — dashboard
cd challenge-frontend && npm run dev            # http://localhost:5173

# T2 — operator view (local only; powers the "Reveal" button)
cd confidential-rebalancer && bun run operator  # http://127.0.0.1:8790

# T3 — the enclave + admin commands (leave in cre/)
cre login                                       # if the session expired
cast balance --rpc-url https://ethereum-sepolia-rpc.publicnode.com \
  0xBe236994504F7B897c7DA48FCA4ddd466a63C783 --ether   # want > 0.05 ETH for gas

# Fresh private challenge so the liquidation half starts clean
cd challenge-contracts
script/deploy.sh && script/scenario.sh join && script/scenario.sh start
cd ..
```

Open http://localhost:5173 — both panels should load. If the rebalancer's
"drift band" under Reveal says "hold", nudge the book off target so the
enclave has something to do on camera (see step 3).

---

## Act 1 — the idea (30s, on the dashboard)

> "Two Chainlink workflows. Everything on this page is public on Sepolia:
> balances, prices, every swap. The strategy that produced it is not — it
> lives in an AWS Nitro enclave, and this page can't show it."

Point at the four **sealed** chips.

## Act 2 — the owner's view (45s)

Click **Reveal sealed values**.

> "I'm the owner, so a process on my laptop can compute what the enclave
> computes from my spec. Base allocation 50/30/20; the risk-parity signal
> tilts it to this — today. Yesterday it was different. These targets are
> never stored; they're recomposed every cycle from live volatility. That's
> why you can't back them out of the trades."

Point at **"What the enclave would do next"** — the plan before it exists.

## Act 3 — the enclave trades (90s)

If the reveal said *hold*, nudge first (T3):

```bash
cast send --rpc-url https://ethereum-sepolia-rpc.publicnode.com --private-key $CRE_ETH_PRIVATE_KEY \
  0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E \
  'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))' \
  "(0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238,0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14,500,0xBe236994504F7B897c7DA48FCA4ddd466a63C783,300000000,0,0)"
#   ^ buys ~$300 of WETH with USDC, pushing WETH overweight
```

Then run the enclave (T3):

```bash
cre workflow simulate ./confidential-rebalancer --target=sepolia-settings --trigger-index=0 --non-interactive
```

> "That box is Chainlink's runtime confirming the handler is registered for
> Nitro. The log says only `rebalance-executed legs=2` — a count. No weights,
> no drift, no amounts."

Back to the dashboard, wait for the refresh (30s, or reload): the swap
appears in the list with its tx hash, the weights move, the reveal now says
*hold*.

> "One transaction — the router's multicall — sold and bought atomically.
> Quoted against the real pool, signed inside the enclave."

## Act 4 — liquidation protection (2 min)

Scroll to the two liquidation panels. Official: hf 1.11, untouched, waiting
for Chainlink to start the scenario. Private copy: our test harness, where we
play Chainlink.

T3, in `cre/challenge-contracts`:

```bash
script/scenario.sh status                # hf 111, safe
```

> "First: the buffer. The workflow's first action at start() is one deposit
> sized so the position survives down to a secret floor price."

```bash
cd .. && cre workflow simulate ./liquidation-protection --target=staging-settings --trigger-index=1 --non-interactive
cd challenge-contracts && script/scenario.sh status     # collateral up, hf ~1.3
```

> "Now the crash."

```bash
WAIT=45 script/scenario.sh price 1300    # prints LIQUIDATABLE? no — the buffer holds. Then:
WAIT=45 script/scenario.sh price 1100    # below the floor -> LIQUIDATABLE
```

While it waits, in the other terminal:

```bash
cre workflow simulate ./liquidation-protection --target=staging-settings --trigger-index=1 --non-interactive
```

> "`acted kind=deposit`. It topped up before the admin's liquidation check."

The runner's wait ends, `checkAllHF()` runs, `liquidations 0`. Dashboard:
the private panel shows the deposits under Workflow actions, hf back above 1.

> "Debt never changed. Loan continuity: 100%. And the numbers that decided
> all of this — trigger, target, floor, caps — are the sealed chips."

## Act 5 — close (20s)

Click **Hide sealed values**. Stop the operator process (T2, Ctrl-C), reload:
the button is gone.

> "That's the whole claim. Public actions, private decisions. The only party
> who can see the strategy is the one who wrote it."

---

## If something goes wrong

| Symptom | Fix |
|---|---|
| Dashboard panels stuck on "loading…" | RPC rate-limited; reload after 10s |
| `rebalance-skip reason=within-band` | book is on target — do the nudge in Act 3 |
| `rpc eth_sendRawTransaction failed` | a previous tx still pending; wait 20s, rerun |
| `held reason=inactive` | private scenario not started: `script/scenario.sh start` |
| `held reason=cooldown` | non-critical top-up inside cooldown; drop the price further (critical ignores cooldown) |
| `LimitExceeded ... 15` | more than 15 HTTP calls; should not happen with ≤ 6 trades |
| Reveal button missing | operator service not running (T2) |

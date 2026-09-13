#!/usr/bin/env bash
# Play the Chainlink admin against our PRIVATE copy of the challenge.
#
#   scenario.sh join                 join() + approve both tokens (as participant)
#   scenario.sh start                start() the scenario clock
#   scenario.sh status               position, hf, balances, liquidation events
#   scenario.sh price 1750           updatevETHPrice(1750.00) then checkAllHF()
#   scenario.sh run gradual-decline  step a named price path, WAIT seconds between
#                                    the price update and the liquidation check
#   scenario.sh stop                 stop(): freezes the loan-continuity score
#
# A started scenario cannot be reset -- redeploy (script/deploy.sh) for a fresh
# one. Reads CRE_ETH_PRIVATE_KEY from cre/.env; never prints it.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ../.env; set +a
: "${CRE_ETH_PRIVATE_KEY:?set CRE_ETH_PRIVATE_KEY in cre/.env}"

CAST=${CAST:-$HOME/.foundry/bin/cast}
RPC=${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}
WAIT=${WAIT:-90}   # seconds the workflow gets to react before checkAllHF()
addr() { python3 -c "import json; print(json.load(open('addresses.json'))['$1'])"; }
LENDING=$(addr lending); VETH=$(addr vETH); VUSD=$(addr vUSD)
ME=$($CAST wallet address --private-key "$CRE_ETH_PRIVATE_KEY")
MAX=0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff

tx() { # $1 label, rest = cast send args
  local label=$1; shift
  local out hash status
  out=$($CAST send --rpc-url "$RPC" --private-key "$CRE_ETH_PRIVATE_KEY" --json "$@")
  hash=$(printf '%s' "$out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["transactionHash"])')
  status=$(printf '%s' "$out" | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])')
  printf '  %-26s %s  %s\n' "$label" "${hash:0:18}…" "$([ "$status" = 0x1 ] && echo ok || echo REVERTED)"
  [ "$status" = "0x1" ]
}
u() { local v; v=$($CAST call --rpc-url "$RPC" "$@"); echo "${v%% *}"; }   # leading integer only
fmt2() { python3 -c "v=int('$1'); print(f'{v//100}.{v%100:02d}')"; }

status() {
  local pos price free_eth free_usd
  pos=$($CAST call --rpc-url "$RPC" "$LENDING" 'getUserPosition(address)((uint256,uint256,uint256,uint256,uint256,uint256))' "$ME")
  price=$(u "$LENDING" 'vETHPrice()(uint256)')
  free_eth=$(u "$VETH" 'balanceOf(address)(uint256)' "$ME"); free_usd=$(u "$VUSD" 'balanceOf(address)(uint256)' "$ME")
  python3 - "$pos" "$price" "$free_eth" "$free_usd" <<'PY'
import sys, re
# cast annotates big numbers as "700000 [7e5]"; strip the annotations first.
clean = re.sub(r"\[[^\]]*\]", "", sys.argv[1])
nums = [int(x) for x in re.findall(r"\d+", clean)][:6]
coll, debt, hf, ops, last, cdt = nums
price, feth, fusd = (int(sys.argv[i]) for i in (2, 3, 4))
live_hf = coll * price * 78 // (100 * debt) if debt else None
print(f"  price        {price/100:>10.2f} vUSD/vETH")
print(f"  collateral   {coll/100:>10.2f} vETH      free vETH {feth/100:.2f}")
print(f"  debt         {debt/100:>10.2f} vUSD      free vUSD {fusd/100:.2f}")
print(f"  hf (stored)  {hf:>10}          hf at current price {live_hf}   {'LIQUIDATABLE' if live_hf is not None and live_hf <= 100 else 'safe'}")
print(f"  operations   {ops:>10}")
PY
  local liq; liq=$($CAST logs --rpc-url "$RPC" --from-block 0 --address "$LENDING" 'Liquidated(address,uint256,uint256)' 2>/dev/null | grep -c "blockNumber" || true)
  echo "  liquidations ${liq:-0}"
}

case "${1:-}" in
  join)
    if [ "$(u "$LENDING" 'isUser(address)(bool)' "$ME")" = "true" ]; then echo "  already joined"; else tx "join()" "$LENDING" 'join()'; fi
    tx "vUSD.approve(max)" "$VUSD" 'approve(address,uint256)' "$LENDING" $MAX
    tx "vETH.approve(max)" "$VETH" 'approve(address,uint256)' "$LENDING" $MAX
    status ;;
  start) tx "start()" "$LENDING" 'start()'; status ;;
  stop)  tx "stop()" "$LENDING" 'stop()'; echo "  continuity $(u "$LENDING" 'loanContinuityScore(address)(uint256)' "$ME") bps"; status ;;
  status) status ;;
  price)
    p=$(python3 -c "print(int(round(float('$2')*100)))")
    tx "updatevETHPrice($2)" "$LENDING" 'updatevETHPrice(uint256)' "$p"
    echo "  waiting ${WAIT}s for the workflow to react…"; sleep "$WAIT"
    tx "checkAllHF()" "$LENDING" 'checkAllHF()'; status ;;
  run)
    case "$2" in
      gradual-decline) path="1850 1750 1650 1550" ;;
      sudden-crash)    path="1700 1625 1450" ;;
      temporary-wick)  path="1750 1620 1900" ;;
      two-stage)       path="1750 1650 1650 1500" ;;
      safe-volatility) path="1800 1950 1750 2050" ;;
      *) echo "unknown scenario $2"; exit 2 ;;
    esac
    echo "scenario $2: 2000 -> $path"
    for p in $path; do echo; echo "== price -> $p"; "$0" price "$p"; done ;;
  *) sed -n '2,14p' "$0"; exit 2 ;;
esac

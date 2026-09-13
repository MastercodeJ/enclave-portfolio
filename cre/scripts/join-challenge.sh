#!/usr/bin/env bash
# One-shot setup for the Automated Liquidation Protection Challenge.
#
#   1. join()                          -> creates the virtual position
#   2. vUSD.approve(lending, max)      -> so repay() never needs an approve tx
#   3. vETH.approve(lending, max)      -> so deposit() never needs one either
#
# Pre-approving is deliberate: approvals reveal nothing about the strategy, and
# doing them now means the enclave's intervention is a single transaction --
# seconds matter between updatevETHPrice() and checkAllHF().
#
# Reads CRE_ETH_PRIVATE_KEY from cre/.env. Never prints it.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

CAST=${CAST:-$HOME/.foundry/bin/cast}
RPC=${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}
LENDING=0x88574e7Cc0027afd04951daa09B64d4441931ba1
VETH=0x5dED1a40c3D56dA42E7f932f781c0432556c9814
VUSD=0x6Fe92Ead5299040f50F095860b5A0A7A2D4041A2
MAX=0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff

: "${CRE_ETH_PRIVATE_KEY:?set CRE_ETH_PRIVATE_KEY in cre/.env}"
ADDR=$($CAST wallet address --private-key "$CRE_ETH_PRIVATE_KEY")
echo "wallet $ADDR"

send() { # $1 label, rest = cast send args
  local label=$1; shift
  local out
  out=$($CAST send --rpc-url "$RPC" --private-key "$CRE_ETH_PRIVATE_KEY" --json "$@")
  local hash status
  hash=$(printf '%s' "$out" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["transactionHash"])')
  status=$(printf '%s' "$out" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["status"])')
  printf '%-14s %s  status=%s\n' "$label" "$hash" "$status"
  [ "$status" = "0x1" ] || { echo "  -> reverted"; exit 1; }
}

if [ "$($CAST call --rpc-url "$RPC" $LENDING 'isUser(address)(bool)' "$ADDR")" = "true" ]; then
  echo "join           already joined, skipping"
else
  send "join()" $LENDING 'join()'
fi

need_approval() { # $1 token
  local a; a=$($CAST call --rpc-url "$RPC" "$1" 'allowance(address,address)(uint256)' "$ADDR" $LENDING)
  # cast may print "N [1e18]" style; take the leading integer
  a=${a%% *}
  python3 -c "import sys; sys.exit(0 if int('$a') < 2**200 else 1)"
}
if need_approval $VUSD; then send "vUSD.approve" $VUSD 'approve(address,uint256)' $LENDING $MAX; else echo "vUSD.approve   already approved"; fi
if need_approval $VETH; then send "vETH.approve" $VETH 'approve(address,uint256)' $LENDING $MAX; else echo "vETH.approve   already approved"; fi

echo
echo "position:"
$CAST call --rpc-url "$RPC" $LENDING 'getUserPosition(address)((uint256,uint256,uint256,uint256,uint256,uint256))' "$ADDR"
echo "free vETH: $($CAST call --rpc-url "$RPC" $VETH 'balanceOf(address)(uint256)' "$ADDR")   free vUSD: $($CAST call --rpc-url "$RPC" $VUSD 'balanceOf(address)(uint256)' "$ADDR")"

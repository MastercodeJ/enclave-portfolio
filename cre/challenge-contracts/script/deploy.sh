#!/usr/bin/env bash
# Deploy a PRIVATE copy of the challenge contracts to Sepolia, with our wallet
# as admin, so we can run the market scenarios ourselves:
#
#   TokenvETH, TokenvUSD, ChallengeLending(vETH, vUSD)
#   grant ADMIN_ROLE on both tokens to the lending contract (it mints on join,
#   burns on repay)
#   open()
#
# Addresses are written to addresses.json for the scenario runner and the
# workflow config. Reads CRE_ETH_PRIVATE_KEY from cre/.env; never prints it.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ../.env; set +a
: "${CRE_ETH_PRIVATE_KEY:?set CRE_ETH_PRIVATE_KEY in cre/.env}"

FORGE=${FORGE:-$HOME/.foundry/bin/forge}
CAST=${CAST:-$HOME/.foundry/bin/cast}
RPC=${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}
ADMIN_ROLE=$($CAST keccak "ADMIN_ROLE")
DEPLOYER=$($CAST wallet address --private-key "$CRE_ETH_PRIVATE_KEY")
echo "deployer $DEPLOYER"

deploy() { # $1 label, $2 contract path:name, rest = constructor args
  local label=$1 target=$2; shift 2
  local addr
  addr=$($FORGE create --rpc-url "$RPC" --private-key "$CRE_ETH_PRIVATE_KEY" --broadcast --json "$target" ${1:+--constructor-args "$@"} \
        | python3 -c 'import sys,json; print(json.load(sys.stdin)["deployedTo"])')
  printf '%-16s %s\n' "$label" "$addr"
  echo "$addr"
}

VETH=$(deploy "TokenvETH" src/TokenvETH.sol:TokenvETH | tail -1)
VUSD=$(deploy "TokenvUSD" src/TokenvUSD.sol:TokenvUSD | tail -1)
LENDING=$(deploy "ChallengeLending" src/ChallengeLending.sol:ChallengeLending "$VETH" "$VUSD" | tail -1)

tx() { # $1 label, rest = cast send args
  local label=$1; shift
  local status
  status=$($CAST send --rpc-url "$RPC" --private-key "$CRE_ETH_PRIVATE_KEY" --json "$@" | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])')
  printf '%-16s status=%s\n' "$label" "$status"
  [ "$status" = "0x1" ]
}
tx "vETH.grantRole" "$VETH" 'grantRole(bytes32,address)' "$ADMIN_ROLE" "$LENDING"
tx "vUSD.grantRole" "$VUSD" 'grantRole(bytes32,address)' "$ADMIN_ROLE" "$LENDING"
tx "lending.open()" "$LENDING" 'open()'

cat > addresses.json <<JSON
{
  "network": "ethereum-testnet-sepolia",
  "admin": "$DEPLOYER",
  "vETH": "$VETH",
  "vUSD": "$VUSD",
  "lending": "$LENDING",
  "official_lending": "0x88574e7Cc0027afd04951daa09B64d4441931ba1"
}
JSON
echo; cat addresses.json

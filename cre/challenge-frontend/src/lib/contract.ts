// ─── ABIs ────────────────────────────────────────────────────────────────────

export const LENDING_ABI = [
  // Constants / immutables
  { name: "ADMIN_ROLE", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { name: "MAX_LTV", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "LIQUI_THRESHOLD", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "LIQUI_PENALTY", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },

  // Token + price state
  { name: "vETH", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "vUSD", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "vETHPrice", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "start_vETH", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "start_Collateral", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "start_Debt", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },

  // Challenge + scenario state
  { name: "challengeOpen", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { name: "scenarioStartTime", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "scenarioEndTime", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "loanContinuityScore", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "users", type: "function", stateMutability: "view", inputs: [{ name: "index", type: "uint256" }], outputs: [{ type: "address" }] },
  { name: "numUsers", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "isUser", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "bool" }] },
  {
    name: "getUserPosition", type: "function", stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "tuple", components: [
      { name: "collateral", type: "uint256" },
      { name: "debt", type: "uint256" },
      { name: "hf", type: "uint256" },
      { name: "numOperations", type: "uint256" },
      { name: "lastUpdateTime", type: "uint256" },
      { name: "cumulativeDebtTime", type: "uint256" },
    ]}],
  },
  { name: "listUsers", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { name: "minCollateral", type: "function", stateMutability: "view", inputs: [{ name: "totalDebt", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { name: "hasRole", type: "function", stateMutability: "view", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [{ type: "bool" }] },

  // Nonpayable user actions
  { name: "join", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { name: "deposit", type: "function", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { name: "borrow", type: "function", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { name: "repay", type: "function", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { name: "withdrawCollateral", type: "function", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { name: "calcHF", type: "function", stateMutability: "nonpayable", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "uint256" }] },

  // Admin actions
  { name: "open", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { name: "close", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { name: "start", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { name: "stop", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { name: "checkAllHF", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { name: "updatevETHPrice", type: "function", stateMutability: "nonpayable", inputs: [{ name: "price", type: "uint256" }], outputs: [] },

  // Events
  { name: "Join", type: "event", inputs: [{ name: "user", type: "address", indexed: true }] },
  { name: "Deposit", type: "event", inputs: [{ name: "user", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { name: "Borrow", type: "event", inputs: [{ name: "user", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { name: "Repay", type: "event", inputs: [{ name: "user", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { name: "WithdrawCollateral", type: "event", inputs: [{ name: "user", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { name: "Liquidated", type: "event", inputs: [{ name: "user", type: "address", indexed: true }, { name: "debtRepaid", type: "uint256", indexed: false }, { name: "collateralSeized", type: "uint256", indexed: false }] },
  { name: "PriceUpdate", type: "event", inputs: [{ name: "oldPrice", type: "uint256", indexed: false }, { name: "newPrice", type: "uint256", indexed: false }] },
] as const;

export const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

import { LENDING_ADDRESS, VETH_ADDRESS, VUSD_ADDRESS } from "../../addresses";

// ─── Address helpers ─────────────────────────────────────────────────────────

export function getLendingAddress(): `0x${string}` {
  return (localStorage.getItem("lendingAddress") || import.meta.env.CONTRACT_ADDRESS || LENDING_ADDRESS) as `0x${string}`;
}

export function getVethAddress(): `0x${string}` {
  return (localStorage.getItem("vethAddress") || import.meta.env.VETH_ADDRESS || VETH_ADDRESS) as `0x${string}`;
}

export function getVusdAddress(): `0x${string}` {
  return (localStorage.getItem("vusdAddress") || import.meta.env.VUSD_ADDRESS || VUSD_ADDRESS) as `0x${string}`;
}

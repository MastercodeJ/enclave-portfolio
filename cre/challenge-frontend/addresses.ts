// Which challenge the position page talks to.
//   default         -> our private copy (we are admin: we can move the price)
//   VITE_OFFICIAL=1 -> the official Chainlink contract
const OFFICIAL = import.meta.env.VITE_OFFICIAL === "1";

export const OFFICIAL_LENDING = "0x88574e7Cc0027afd04951daa09B64d4441931ba1" as `0x${string}`;
export const OFFICIAL_VETH    = "0x5dED1a40c3D56dA42E7f932f781c0432556c9814" as `0x${string}`;
export const OFFICIAL_VUSD    = "0x6Fe92Ead5299040f50F095860b5A0A7A2D4041A2" as `0x${string}`;
export const PRIVATE_LENDING  = "0x0e05af11Ef7F718D191A54a15F2627d99df09d98" as `0x${string}`;
export const PRIVATE_VETH     = "0x4aa3D7B770cA3b4050a3321EE3aD875831D2297c" as `0x${string}`;
export const PRIVATE_VUSD     = "0xE41790a327Dc515A76e1d96e41b49655b4258FBe" as `0x${string}`;

export const LENDING_ADDRESS = OFFICIAL ? OFFICIAL_LENDING : PRIVATE_LENDING;
export const VETH_ADDRESS    = OFFICIAL ? OFFICIAL_VETH : PRIVATE_VETH;
export const VUSD_ADDRESS    = OFFICIAL ? OFFICIAL_VUSD : PRIVATE_VUSD;

/** The wallet the workflows act from. Public by nature: its trades are on-chain. */
export const WORKFLOW_WALLET = "0xBe236994504F7B897c7DA48FCA4ddd466a63C783" as `0x${string}`;

/** Enclave Portfolio venue: Uniswap V3 on Sepolia. */
export const UNISWAP = {
  tokens: {
    WETH: { address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14" as `0x${string}`, decimals: 18 },
    USDC: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as `0x${string}`, decimals: 6 },
    LINK: { address: "0x779877A7B0D9E8603169DdbD7836e478b4624789" as `0x${string}`, decimals: 18 },
  },
  pools: {
    WETH_USDC: "0x3289680dD4d6C10bb19b899729cda5eEF58AEfF1" as `0x${string}`,
    WETH_LINK: "0xDD7CC9a0dA070fB8B60dC6680b596133fb4A7100" as `0x${string}`,
  },
};

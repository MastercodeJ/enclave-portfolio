// Which challenge the UI talks to.
//   default        -> our private copy (we are admin: we can move the price)
//   VITE_OFFICIAL=1 -> the official Chainlink contract
const OFFICIAL = import.meta.env.VITE_OFFICIAL === "1";

export const LENDING_ADDRESS = (OFFICIAL ? "0x88574e7Cc0027afd04951daa09B64d4441931ba1" : "0x0e05af11Ef7F718D191A54a15F2627d99df09d98") as `0x${string}`;
export const VETH_ADDRESS    = (OFFICIAL ? "0x5dED1a40c3D56dA42E7f932f781c0432556c9814" : "0x4aa3D7B770cA3b4050a3321EE3aD875831D2297c") as `0x${string}`;
export const VUSD_ADDRESS    = (OFFICIAL ? "0x6Fe92Ead5299040f50F095860b5A0A7A2D4041A2" : "0xE41790a327Dc515A76e1d96e41b49655b4258FBe") as `0x${string}`;

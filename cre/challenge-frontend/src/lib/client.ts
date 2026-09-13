import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

// Vite only exposes VITE_-prefixed variables. Default to a public Sepolia RPC
// that serves eth_getLogs; viem's built-in default does not.
const rpcUrl = (import.meta.env.VITE_RPC_URL as string | undefined) || "https://ethereum-sepolia-rpc.publicnode.com";

export const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(rpcUrl, { batch: true }),
});

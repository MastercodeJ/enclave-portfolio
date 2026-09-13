import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

const rpcUrl = import.meta.env.RPC_URL as string | undefined;

export const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(rpcUrl || undefined),
});

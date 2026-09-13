import { useState, useEffect, useCallback } from "react";
import { type Abi, type WalletClient } from "viem";
import { publicClient } from "./client";

// ─── Read ────────────────────────────────────────────────────────────────────

interface ReadConfig {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args?: unknown[];
  enabled?: boolean;
}

export function useRead<T>(config: ReadConfig, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(config.enabled !== false);
  const [error, setError] = useState<Error | null>(null);

  const fetch = useCallback(async () => {
    if (config.enabled === false) return;
    if (!config.address) return;
    setIsLoading(true);
    try {
      const result = await publicClient.readContract({
        address: config.address,
        abi: config.abi as Abi,
        functionName: config.functionName,
        args: config.args,
      });
      setData(result as T);
    } catch (e) {
      setError(e as Error);
    } finally {
      setIsLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.enabled, config.address, config.functionName, ...deps]);

  useEffect(() => { fetch(); }, [fetch]);

  return { data, isLoading, error, refetch: fetch };
}

// ─── User Position ───────────────────────────────────────────────────────────

export interface UserPosition {
  collateral: bigint;
  debt: bigint;
  hf: bigint;
  numOperations: bigint;
  lastUpdateTime: bigint;
  cumulativeDebtTime: bigint;
}

export function useUserPosition(
  lendingAddress: `0x${string}`,
  abi: readonly unknown[],
  userAddress: `0x${string}` | null
) {
  const [data, setData] = useState<UserPosition | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const fetch = useCallback(async () => {
    if (!userAddress || !lendingAddress) return;
    setIsLoading(true);
    try {
      const result = await publicClient.readContract({
        address: lendingAddress,
        abi: abi as Abi,
        functionName: "getUserPosition",
        args: [userAddress],
      }) as UserPosition;
      setData(result);
    } catch {
      // ignore
    } finally {
      setIsLoading(false);
    }
  }, [lendingAddress, abi, userAddress]);

  useEffect(() => { fetch(); }, [fetch]);

  return { data, isLoading, refetch: fetch };
}

// ─── Write ───────────────────────────────────────────────────────────────────

interface WriteConfig {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args?: unknown[];
  value?: bigint;
}

export function useWrite(walletClient: WalletClient | null) {
  const [isPending, setIsPending] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const write = useCallback(
    async (config: WriteConfig): Promise<boolean> => {
      if (!walletClient) return false;
      setIsPending(true);
      setIsSuccess(false);
      setError(null);
      try {
        const hash = await walletClient.writeContract({
          ...(config as Parameters<typeof walletClient.writeContract>[0]),
          chain: walletClient.chain,
          account: walletClient.account!,
        });
        setIsPending(false);
        setIsConfirming(true);
        await publicClient.waitForTransactionReceipt({ hash });
        setIsConfirming(false);
        setIsSuccess(true);
        return true;
      } catch (e: unknown) {
        const err = e as { shortMessage?: string; message?: string };
        setError(err?.shortMessage ?? err?.message ?? "Transaction failed");
        setIsPending(false);
        setIsConfirming(false);
        return false;
      }
    },
    [walletClient]
  );

  return {
    write,
    isPending,
    isConfirming,
    isSuccess,
    isBusy: isPending || isConfirming,
    error,
    reset: () => setIsSuccess(false),
  };
}

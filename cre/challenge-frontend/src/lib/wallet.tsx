import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createWalletClient, custom, type WalletClient } from "viem";
import { sepolia } from "viem/chains";

const SEPOLIA_HEX = `0x${sepolia.id.toString(16)}`; // 0xaa36a7

interface WalletContextValue {
  address: `0x${string}` | null;
  walletClient: WalletClient | null;
  chainId: number | null;
  isConnected: boolean;
  isWrongNetwork: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchNetwork: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue>({
  address: null,
  walletClient: null,
  chainId: null,
  isConnected: false,
  isWrongNetwork: false,
  connect: async () => {},
  disconnect: () => {},
  switchNetwork: async () => {},
});

function buildClient(account: `0x${string}`): WalletClient {
  return createWalletClient({
    account,
    chain: sepolia,
    transport: custom(window.ethereum!),
  });
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [walletClient, setWalletClient] = useState<WalletClient | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);

  const disconnectedRef = useRef(false);
  const promptedChainRef = useRef<number | null>(null);

  const clear = useCallback(() => {
    setAddress(null);
    setWalletClient(null);
    setChainId(null);
  }, []);

  const sync = useCallback(
    async (requestAccounts = false) => {
      if (typeof window === "undefined" || !window.ethereum) return;
      if (disconnectedRef.current && !requestAccounts) return;

      const accounts = (await window.ethereum.request({
        method: requestAccounts ? "eth_requestAccounts" : "eth_accounts",
      })) as `0x${string}`[];

      if (!accounts || accounts.length === 0) {
        clear();
        return;
      }

      const hexChain = (await window.ethereum.request({
        method: "eth_chainId",
      })) as string;

      setAddress(accounts[0]);
      setChainId(parseInt(hexChain, 16));
      setWalletClient(buildClient(accounts[0]));
    },
    [clear]
  );

  useEffect(() => {
    if (typeof window === "undefined" || !window.ethereum) return;
    const provider = window.ethereum;

    const onAccountsChanged = (...args: unknown[]) => {
      const accs = args[0] as `0x${string}`[];
      if (!accs || accs.length === 0) {
        clear();
        return;
      }
      if (disconnectedRef.current) return;
      setAddress(accs[0]);
      setWalletClient(buildClient(accs[0]));
    };

    const onChainChanged = (...args: unknown[]) => {
      const hexChain = args[0] as string;
      setChainId(parseInt(hexChain, 16));
      if (!disconnectedRef.current && address) setWalletClient(buildClient(address));
    };

    provider.on("accountsChanged", onAccountsChanged);
    provider.on("chainChanged", onChainChanged);

    sync(false);

    return () => {
      provider.removeListener("accountsChanged", onAccountsChanged);
      provider.removeListener("chainChanged", onChainChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = useCallback(async () => {
    if (typeof window === "undefined" || !window.ethereum) {
      alert("Please install MetaMask or another Web3 wallet.");
      return;
    }
    disconnectedRef.current = false;
    try {
      await window.ethereum.request({
        method: "wallet_requestPermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch (err: unknown) {
      if ((err as { code?: number })?.code === 4001) return;
    }
    await sync(true);
  }, [sync]);

  const disconnect = useCallback(() => {
    disconnectedRef.current = true;
    clear();
  }, [clear]);

  const switchNetwork = useCallback(async () => {
    if (typeof window === "undefined" || !window.ethereum) return;
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: SEPOLIA_HEX }],
      });
    } catch (err: unknown) {
      if ((err as { code?: number })?.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: SEPOLIA_HEX,
              chainName: "Sepolia",
              nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
              rpcUrls: ["https://rpc.sepolia.org"],
              blockExplorerUrls: ["https://sepolia.etherscan.io"],
            },
          ],
        });
      } else {
        throw err;
      }
    }
  }, []);

  const isConnected = !!address;
  const isWrongNetwork = isConnected && chainId !== null && chainId !== sepolia.id;

  useEffect(() => {
    if (isWrongNetwork && chainId !== null) {
      if (promptedChainRef.current !== chainId) {
        promptedChainRef.current = chainId;
        switchNetwork().catch(() => {});
      }
    } else {
      promptedChainRef.current = null;
    }
  }, [isWrongNetwork, chainId, switchNetwork]);

  return (
    <WalletContext.Provider
      value={{
        address,
        walletClient,
        chainId,
        isConnected,
        isWrongNetwork,
        connect,
        disconnect,
        switchNetwork,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export const useWallet = () => useContext(WalletContext);

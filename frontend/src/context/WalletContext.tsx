import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  StellarWalletsKit,
  WalletNetwork,
  FreighterModule,
  xBullModule,
  AlbedoModule,
  LobstrModule,
  WalletConnectModule,
} from '@creit.tech/stellar-wallets-kit';

export type WalletId = 'freighter' | 'xbull' | 'albedo' | 'lobstr' | 'walletconnect';

export interface WalletOption {
  id: WalletId;
  name: string;
  icon: string;
  description: string;
  installUrl: string;
}

export const WALLET_OPTIONS: WalletOption[] = [
  {
    id: 'freighter',
    name: 'Freighter',
    icon: 'https://stellar.creit.tech/wallet-icons/freighter.png',
    description: 'Browser extension by Stellar Development Foundation.',
    installUrl: 'https://www.freighter.app/',
  },
  {
    id: 'xbull',
    name: 'xBull',
    icon: 'https://stellar.creit.tech/wallet-icons/xbull.png',
    description: 'Feature-rich extension and mobile wallet.',
    installUrl: 'https://xbull.app/',
  },
  {
    id: 'albedo',
    name: 'Albedo',
    icon: 'https://stellar.creit.tech/wallet-icons/albedo.png',
    description: 'Web-based signer, no extension required.',
    installUrl: 'https://albedo.link/',
  },
  {
    id: 'lobstr',
    name: 'Lobstr',
    icon: 'https://stellar.creit.tech/wallet-icons/lobstr.png',
    description: 'Popular mobile and web wallet.',
    installUrl: 'https://lobstr.co/',
  },
  {
    id: 'walletconnect',
    name: 'WalletConnect',
    icon: 'https://stellar.creit.tech/wallet-icons/walletconnect.png',
    description: 'Connect any WalletConnect-compatible wallet.',
    installUrl: 'https://walletconnect.com/',
  },
];

const STORAGE_KEY = 'stellar.wallet.provider';
const NETWORK = (process.env.NEXT_PUBLIC_STELLAR_NETWORK as WalletNetwork) || WalletNetwork.TESTNET;

interface WalletContextValue {
  address: string | null;
  walletId: WalletId | null;
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  connect: (id: WalletId) => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string) => Promise<string>;
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

function buildKit() {
  return new StellarWalletsKit({
    network: NETWORK,
    selectedWalletId: 'freighter',
    modules: [
      new FreighterModule(),
      new xBullModule(),
      new AlbedoModule(),
      new LobstrModule(),
      new WalletConnectModule({
        projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '',
        metadata: {
          name: 'Stellar Betting',
          description: 'Place bets on Stellar',
          url: typeof window !== 'undefined' ? window.location.origin : '',
          icons: [],
        },
      }),
    ],
  });
}

export const WalletProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [address, setAddress] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<WalletId | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async (id: WalletId) => {
    setIsConnecting(true);
    setError(null);
    try {
      const kit = buildKit();
      kit.setWallet(id);
      const { address: addr } = await kit.getAddress();
      setAddress(addr);
      setWalletId(id);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, id);
      }
    } catch (err) {
      const option = WALLET_OPTIONS.find((w) => w.id === id);
      const message =
        err instanceof Error && /not.*(installed|found)/i.test(err.message)
          ? `${option?.name ?? 'Wallet'} is not installed. Install it at ${option?.installUrl ?? ''}`
          : `Failed to connect ${option?.name ?? 'wallet'}. Please try again.`;
      setError(message);
      throw err;
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    setWalletId(null);
    setError(null);
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const signTransaction = useCallback(
    async (xdr: string) => {
      if (!address) throw new Error('Wallet not connected');
      const kit = buildKit();
      if (walletId) kit.setWallet(walletId);
      const { signedTxXdr } = await kit.signTransaction(xdr, { address });
      return signedTxXdr;
    },
    [address, walletId],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(STORAGE_KEY) as WalletId | null;
    if (saved && WALLET_OPTIONS.some((w) => w.id === saved)) {
      connect(saved).catch(() => {
        window.localStorage.removeItem(STORAGE_KEY);
      });
    }
  }, [connect]);

  const value = useMemo<WalletContextValue>(
    () => ({
      address,
      walletId,
      isConnected: Boolean(address),
      isConnecting,
      error,
      connect,
      disconnect,
      signTransaction,
    }),
    [address, walletId, isConnecting, error, connect, disconnect, signTransaction],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
};

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within a WalletProvider');
  return ctx;
}

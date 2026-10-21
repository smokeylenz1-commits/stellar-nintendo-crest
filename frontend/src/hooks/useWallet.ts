import { useCallback, useEffect, useRef, useState } from 'react';
import {
  StellarWalletsKit,
  WalletNetwork,
  FreighterModule,
  xBullModule,
  AlbedoModule,
  LobstrModule,
  WalletConnectModule,
} from '@creit.tech/stellar-wallets-kit';

export type WalletId =
  | 'freighter'
  | 'xbull'
  | 'albedo'
  | 'lobstr'
  | 'walletconnect';

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
    description: 'Extension and mobile wallet with advanced features.',
    installUrl: 'https://xbull.app/',
  },
  {
    id: 'albedo',
    name: 'Albedo',
    icon: 'https://stellar.creit.tech/wallet-icons/albedo.png',
    description: 'Web-based signer — no extension required.',
    installUrl: 'https://albedo.link/',
  },
  {
    id: 'lobstr',
    name: 'Lobstr',
    icon: 'https://stellar.creit.tech/wallet-icons/lobstr.png',
    description: 'Popular mobile and web wallet for Stellar.',
    installUrl: 'https://lobstr.co/',
  },
  {
    id: 'walletconnect',
    name: 'WalletConnect',
    icon: 'https://stellar.creit.tech/wallet-icons/walletconnect.png',
    description: 'Connect any WalletConnect-compatible mobile wallet.',
    installUrl: 'https://walletconnect.com/',
  },
];

const STORAGE_KEY = 'stellar.wallet.provider';
const NETWORK =
  (process.env.NEXT_PUBLIC_STELLAR_NETWORK as WalletNetwork) ||
  WalletNetwork.TESTNET;

let kitInitialized = false;

function initKit() {
  if (kitInitialized) return;
  StellarWalletsKit.init({
    network: NETWORK,
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
  kitInitialized = true;
}

export interface UseWalletResult {
  address: string | null;
  walletId: WalletId | null;
  connecting: boolean;
  error: string | null;
  connect: (id: WalletId) => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string) => Promise<string>;
}

export function useWallet(): UseWalletResult {
  const [address, setAddress] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<WalletId | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reconnectAttempted = useRef(false);

  const connect = useCallback(async (id: WalletId) => {
    setConnecting(true);
    setError(null);
    try {
      initKit();
      StellarWalletsKit.setWallet(id);
      const { address: addr } = await StellarWalletsKit.getAddress();
      setAddress(addr);
      setWalletId(id);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, id);
      }
    } catch (err) {
      const option = WALLET_OPTIONS.find((w) => w.id === id);
      const message =
        err instanceof Error && err.message
          ? err.message
          : `${option?.name ?? 'Wallet'} is not available. Install it from ${
              option?.installUrl ?? 'the wallet website'
            } and try again.`;
      setError(message);
      setAddress(null);
      setWalletId(null);
    } finally {
      setConnecting(false);
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
    async (xdr: string): Promise<string> => {
      initKit();
      const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
        networkPassphrase: NETWORK,
      });
      return signedTxXdr;
    },
    [],
  );

  useEffect(() => {
    if (reconnectAttempted.current) return;
    reconnectAttempted.current = true;
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(STORAGE_KEY) as WalletId | null;
    if (stored && WALLET_OPTIONS.some((w) => w.id === stored)) {
      void connect(stored);
    }
  }, [connect]);

  return {
    address,
    walletId,
    connecting,
    error,
    connect,
    disconnect,
    signTransaction,
  };
}

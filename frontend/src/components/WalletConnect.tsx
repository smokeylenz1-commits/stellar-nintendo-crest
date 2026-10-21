import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  StellarWalletsKit,
  WalletNetwork,
  FreighterModule,
  xBullModule,
  AlbedoModule,
  LobstrModule,
  WalletConnectModule,
} from '@creit.tech/stellar-wallets-kit';

const STORAGE_KEY = 'stellar.wallet.provider';

interface WalletOption {
  id: string;
  name: string;
  icon: string;
  guide: string;
}

const WALLETS: WalletOption[] = [
  {
    id: 'freighter',
    name: 'Freighter',
    icon: '🦊',
    guide: 'Install the Freighter browser extension, then refresh this page.',
  },
  {
    id: 'xbull',
    name: 'xBull',
    icon: '🐂',
    guide: 'Install the xBull extension or mobile app, then reconnect.',
  },
  {
    id: 'albedo',
    name: 'Albedo',
    icon: '🌐',
    guide: 'Albedo opens in a new tab — no extension required.',
  },
  {
    id: 'lobstr',
    name: 'Lobstr',
    icon: '🦞',
    guide: 'Use the Lobstr mobile app and scan the WalletConnect QR code.',
  },
  {
    id: 'walletconnect',
    name: 'WalletConnect',
    icon: '🔗',
    guide: 'Scan the QR code with any WalletConnect-compatible wallet.',
  },
];

function buildKit(selectedId: string): StellarWalletsKit {
  const modules = [
    new FreighterModule(),
    new xBullModule(),
    new AlbedoModule(),
    new LobstrModule(),
    new WalletConnectModule({
      projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '',
      metadata: {
        name: 'Stellar Betting',
        description: 'Place bets on Stellar',
        url: typeof window !== 'undefined' ? window.location.origin : '',
        icons: [],
      },
    }),
  ];

  const kit = new StellarWalletsKit({
    network: WalletNetwork.PUBLIC,
    selectedWalletId: selectedId,
    modules,
  });

  return kit;
}

interface WalletConnectProps {
  onConnect?: (address: string) => void;
  onDisconnect?: () => void;
}

export default function WalletConnect({ onConnect, onDisconnect }: WalletConnectProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const kit = useMemo(() => buildKit(localStorage.getItem(STORAGE_KEY) ?? 'freighter'), []);

  const connect = useCallback(
    async (wallet: WalletOption) => {
      setError(null);
      setConnectingId(wallet.id);
      try {
        kit.setWallet(wallet.id);
        const { address: connected } = await kit.getAddress();
        localStorage.setItem(STORAGE_KEY, wallet.id);
        setAddress(connected);
        setIsModalOpen(false);
        onConnect?.(connected);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(
          /not (installed|found|available)/i.test(message)
            ? `${wallet.name} is not installed. ${wallet.guide}`
            : `Could not connect to ${wallet.name}. ${wallet.guide}`,
        );
      } finally {
        setConnectingId(null);
      }
    },
    [kit, onConnect],
  );

  const disconnect = useCallback(() => {
    setAddress(null);
    localStorage.removeItem(STORAGE_KEY);
    onDisconnect?.();
  }, [onDisconnect]);

  // Automatic reconnect using the persisted provider.
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    const wallet = WALLETS.find((w) => w.id === saved);
    if (!wallet) return;
    let cancelled = false;
    (async () => {
      try {
        kit.setWallet(wallet.id);
        const { address: connected } = await kit.getAddress();
        if (!cancelled && connected) {
          setAddress(connected);
          onConnect?.(connected);
        }
      } catch {
        // Silent: user simply needs to reconnect manually.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kit, onConnect]);

  return (
    <div className="wallet-connect">
      {address ? (
        <div className="wallet-connect__connected">
          <span className="wallet-connect__address" title={address}>
            {address.slice(0, 4)}…{address.slice(-4)}
          </span>
          <button type="button" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setIsModalOpen(true)}>
          Connect Wallet
        </button>
      )}

      {isModalOpen && (
        <div
          className="wallet-connect__overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Select a wallet"
          onClick={() => setIsModalOpen(false)}
        >
          <div className="wallet-connect__modal" onClick={(e) => e.stopPropagation()}>
            <h2>Connect a wallet</h2>
            <ul className="wallet-connect__list">
              {WALLETS.map((wallet) => (
                <li key={wallet.id}>
                  <button
                    type="button"
                    className="wallet-connect__option"
                    disabled={connectingId !== null}
                    onClick={() => connect(wallet)}
                  >
                    <span className="wallet-connect__icon" aria-hidden="true">
                      {wallet.icon}
                    </span>
                    <span className="wallet-connect__meta">
                      <span className="wallet-connect__name">{wallet.name}</span>
                      <span className="wallet-connect__guide">{wallet.guide}</span>
                    </span>
                    {connectingId === wallet.id && <span>Connecting…</span>}
                  </button>
                </li>
              ))}
            </ul>
            {error && (
              <p className="wallet-connect__error" role="alert">
                {error}
              </p>
            )}
            <button type="button" onClick={() => setIsModalOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

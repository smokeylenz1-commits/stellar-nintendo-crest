import React, { useEffect, useRef } from 'react';

interface WalletModalProps {
  isOpen: boolean;
  onClose: () => void;
  balance?: string;
  address?: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

const WalletModal: React.FC<WalletModalProps> = ({
  isOpen,
  onClose,
  balance,
  address,
  onConnect,
  onDisconnect,
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const modal = modalRef.current;
    if (!modal) return;

    const focusableSelector =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const getFocusable = () =>
      Array.from(modal.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );

    const focusables = getFocusable();
    if (focusables.length > 0) {
      focusables[0].focus();
    } else {
      modal.focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const items = getFocusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (active === first || !modal.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !modal.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused.current?.focus?.();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="wallet-modal-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={modalRef}
        className="wallet-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wallet-modal-header">
          <h2 id="wallet-modal-title" className="wallet-modal-title">
            Wallet
          </h2>
          <button
            type="button"
            className="wallet-modal-close"
            onClick={onClose}
            aria-label="Close wallet dialog"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <div className="wallet-modal-body">
          {address ? (
            <>
              <p className="wallet-modal-label">Connected address</p>
              <p className="wallet-modal-address">{address}</p>
              <p className="wallet-modal-label">Balance</p>
              <p className="wallet-modal-balance">{balance ?? '—'}</p>
              {onDisconnect && (
                <button
                  type="button"
                  className="wallet-modal-action"
                  onClick={onDisconnect}
                  aria-label="Disconnect wallet"
                >
                  Disconnect
                </button>
              )}
            </>
          ) : (
            <>
              <p className="wallet-modal-empty">
                No wallet connected. Connect a wallet to place bets.
              </p>
              {onConnect && (
                <button
                  type="button"
                  className="wallet-modal-action"
                  onClick={onConnect}
                  aria-label="Connect wallet"
                >
                  Connect Wallet
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default WalletModal;

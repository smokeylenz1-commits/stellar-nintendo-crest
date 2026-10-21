import { useEffect, useRef } from 'react';

interface SubmitOutcomeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (outcome: string) => void;
  marketTitle?: string;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function SubmitOutcomeModal({
  isOpen,
  onClose,
  onSubmit,
  marketTitle,
}: SubmitOutcomeModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const dialog = dialogRef.current;
    const focusables = dialog
      ? Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      : [];
    (focusables[0] ?? dialog)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;

      const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (nodes.length === 0) {
        event.preventDefault();
        return;
      }

      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
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
      className="modal-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className="modal-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby="submit-outcome-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="submit-outcome-title" className="modal-title">
            Submit Outcome
          </h2>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close submit outcome dialog"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        {marketTitle && (
          <p className="modal-subtitle">{marketTitle}</p>
        )}

        <div className="modal-body">
          <button
            type="button"
            className="outcome-button outcome-yes"
            onClick={() => onSubmit('YES')}
            aria-label="Submit outcome: Yes"
          >
            Yes
          </button>
          <button
            type="button"
            className="outcome-button outcome-no"
            onClick={() => onSubmit('NO')}
            aria-label="Submit outcome: No"
          >
            No
          </button>
        </div>
      </div>
    </div>
  );
}

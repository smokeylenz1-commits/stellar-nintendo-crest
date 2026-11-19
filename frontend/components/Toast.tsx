import { useEffect, useRef } from 'react';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastProps {
  id?: string;
  message: string;
  type?: ToastType;
  duration?: number;
  onDismiss?: (id?: string) => void;
}

const typeStyles: Record<ToastType, string> = {
  success: 'bg-green-600 text-white',
  error: 'bg-red-600 text-white',
  info: 'bg-blue-600 text-white',
  warning: 'bg-yellow-500 text-black',
};

const typeRole: Record<ToastType, 'status' | 'alert'> = {
  success: 'status',
  info: 'status',
  warning: 'alert',
  error: 'alert',
};

export default function Toast({
  id,
  message,
  type = 'info',
  duration = 5000,
  onDismiss,
}: ToastProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!onDismiss || duration <= 0) return;
    timerRef.current = setTimeout(() => onDismiss(id), duration);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [id, duration, onDismiss]);

  const handleDismiss = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    onDismiss?.(id);
  };

  return (
    <div
      role={typeRole[type]}
      aria-live={typeRole[type] === 'alert' ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={`pointer-events-auto flex items-center gap-3 rounded-md px-4 py-3 shadow-lg ${typeStyles[type]}`}
    >
      <span className="flex-1 text-sm">{message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss notification"
          className="rounded p-1 hover:bg-black/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
}

import { formatContractError } from "./contract-errors";

export type ToastType = "success" | "error" | "info" | "warning";

export interface ToastOptions {
  type?: ToastType;
  duration?: number;
  description?: string;
}

export interface Toast {
  id: string;
  title: string;
  description?: string;
  type: ToastType;
  duration: number;
}

type ToastListener = (toasts: Toast[]) => void;

const listeners = new Set<ToastListener>();
let toasts: Toast[] = [];

function emit(): void {
  for (const listener of listeners) {
    listener(toasts);
  }
}

export function subscribe(listener: ToastListener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}

export function dismissToast(id: string): void {
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

export function showToast(
  title: string,
  options: ToastOptions = {},
): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const toast: Toast = {
    id,
    title,
    description: options.description,
    type: options.type ?? "info",
    duration: options.duration ?? 5000,
  };

  toasts = [...toasts, toast];
  emit();

  if (toast.duration > 0) {
    setTimeout(() => dismissToast(id), toast.duration);
  }

  return id;
}

/**
 * Show an error toast, translating known Soroban contract error codes
 * (21-28) into plain-language messages with resolution advice.
 *
 * Falls back to the provided message when the error is not a recognized
 * contract code, so raw numeric codes are never surfaced to users.
 */
export function showContractErrorToast(
  error: unknown,
  fallbackMessage = "Transaction failed. Please try again.",
): string {
  const formatted = formatContractError(error);
  return showToast(formatted ?? fallbackMessage, { type: "error" });
}

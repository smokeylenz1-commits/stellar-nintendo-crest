/**
 * Resilient API client with graceful fallback from the Backend API to
 * direct Soroban RPC queries when the backend is unavailable.
 *
 * When the backend returns HTTP 500/503 or the request times out, the client
 * transparently falls back to querying contract state directly via Soroban RPC
 * so core betting and claims keep working during backend downtime.
 */

const DEFAULT_TIMEOUT_MS = 8000;

const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
  process.env.NEXT_PUBLIC_RPC_URL ??
  "https://soroban-testnet.stellar.org";

const CONTRACT_ID =
  process.env.NEXT_PUBLIC_CONTRACT_ID ??
  process.env.NEXT_PUBLIC_SOROBAN_CONTRACT_ID ??
  "";

const BACKEND_BASE_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "";

const USE_BACKEND = process.env.NEXT_PUBLIC_USE_BACKEND !== "false";

/**
 * Emitted whenever the client switches to (or recovers from) direct on-chain
 * mode. Consumers can subscribe to render the non-intrusive warning banner
 * "Operating in direct on-chain mode".
 */
export const FALLBACK_EVENT = "api-client:fallback";

export interface FallbackStatus {
  active: boolean;
  reason?: string;
}

let fallbackActive = false;

function setFallback(active: boolean, reason?: string): void {
  if (fallbackActive === active) return;
  fallbackActive = active;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<FallbackStatus>(FALLBACK_EVENT, {
        detail: { active, reason },
      }),
    );
  }
}

export function isFallbackActive(): boolean {
  return fallbackActive;
}

/**
 * Subscribe to fallback status changes. Returns an unsubscribe function.
 */
export function onFallbackChange(
  listener: (status: FallbackStatus) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    listener((event as CustomEvent<FallbackStatus>).detail);
  };
  window.addEventListener(FALLBACK_EVENT, handler);
  return () => window.removeEventListener(FALLBACK_EVENT, handler);
}

/**
 * Fetch with an abort-based timeout so hung backend requests fail fast and
 * trigger the on-chain fallback instead of blocking the UI.
 */
async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Query contract state directly via Soroban RPC using a read-only
 * `simulateTransaction` call. This is the fallback path used when the backend
 * is unavailable.
 */
async function sorobanRpcCall<T>(
  method: string,
  params: unknown,
): Promise<T> {
  const response = await fetchWithTimeout(SOROBAN_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`Soroban RPC error: ${response.status}`);
  }

  const payload = (await response.json()) as {
    result?: T;
    error?: { message?: string };
  };

  if (payload.error) {
    throw new Error(payload.error.message ?? "Soroban RPC error");
  }

  return payload.result as T;
}

/**
 * Read contract state directly from the chain. Used as the fallback for
 * backend read endpoints (e.g. markets, positions, balances).
 */
export async function fetchContractState<T>(
  method: string,
  params: unknown = {},
): Promise<T> {
  return sorobanRpcCall<T>("simulateTransaction", {
    contractId: CONTRACT_ID,
    method,
    params,
  });
}

/**
 * Resilient fetch wrapper.
 *
 * Attempts the backend endpoint first. On HTTP 500/503 or a network timeout it
 * transparently falls back to querying contract state directly via Soroban RPC
 * and flags direct on-chain mode so the UI can show a non-intrusive warning.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  fallback?: { method: string; params?: unknown },
): Promise<T> {
  if (USE_BACKEND && BACKEND_BASE_URL) {
    try {
      const response = await fetchWithTimeout(
        `${BACKEND_BASE_URL}${path}`,
        init,
      );

      if (response.status === 500 || response.status === 503) {
        throw new Error(`Backend unavailable: ${response.status}`);
      }

      if (!response.ok) {
        throw new Error(`Backend error: ${response.status}`);
      }

      setFallback(false);
      return (await response.json()) as T;
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "Backend request failed";
      setFallback(true, reason);
    }
  }

  if (!fallback) {
    throw new Error("Backend unavailable and no on-chain fallback provided");
  }

  setFallback(true, "Backend unavailable");
  return fetchContractState<T>(fallback.method, fallback.params ?? {});
}

export default apiFetch;

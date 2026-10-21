"use client";

import { useEffect, useRef, useState } from "react";

export type NetworkStatus = "live" | "reconnecting" | "offline";

interface UseNetworkStatusOptions {
  /**
   * Optional SSE/EventSource instance (or any object exposing readyState)
   * whose connection state should be reflected in the status.
   */
  eventSource?: EventSource | null;
  /**
   * How long to wait after a connection drop before reporting "offline"
   * instead of "reconnecting". Defaults to 10s.
   */
  offlineAfterMs?: number;
}

const DEFAULT_OFFLINE_AFTER_MS = 10_000;

/**
 * Tracks browser connectivity (navigator.onLine) together with an optional
 * SSE connection state and derives a single network status:
 *
 *  - "live"         -> online and (if provided) SSE is OPEN
 *  - "reconnecting" -> online but SSE is CONNECTING, or a recent drop
 *  - "offline"      -> navigator.onLine is false, or the drop persisted
 */
export function useNetworkStatus(
  options: UseNetworkStatusOptions = {},
): NetworkStatus {
  const { eventSource = null, offlineAfterMs = DEFAULT_OFFLINE_AFTER_MS } =
    options;

  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [sseState, setSseState] = useState<number | null>(() =>
    eventSource ? eventSource.readyState : null,
  );
  const [isReconnecting, setIsReconnecting] = useState(false);

  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track navigator.onLine.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Track SSE connection state.
  useEffect(() => {
    if (!eventSource) {
      setSseState(null);
      return;
    }

    setSseState(eventSource.readyState);

    const handleOpen = () => setSseState(EventSource.OPEN);
    const handleError = () => setSseState(eventSource.readyState);

    eventSource.addEventListener("open", handleOpen);
    eventSource.addEventListener("error", handleError);

    return () => {
      eventSource.removeEventListener("open", handleOpen);
      eventSource.removeEventListener("error", handleError);
    };
  }, [eventSource]);

  // Derive "reconnecting" vs "offline" from the SSE state.
  useEffect(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }

    if (!isOnline) {
      setIsReconnecting(false);
      return;
    }

    if (sseState === null || sseState === EventSource.OPEN) {
      setIsReconnecting(false);
      return;
    }

    // SSE is CONNECTING or CLOSED while the browser reports online.
    setIsReconnecting(true);
    reconnectTimer.current = setTimeout(() => {
      setIsReconnecting(false);
    }, offlineAfterMs);

    return () => {
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
    };
  }, [isOnline, sseState, offlineAfterMs]);

  if (!isOnline) return "offline";
  if (sseState === EventSource.CLOSED && !isReconnecting) return "offline";
  if (isReconnecting || sseState === EventSource.CONNECTING) {
    return "reconnecting";
  }
  return "live";
}

export default useNetworkStatus;

"use client";

import { useState, useCallback } from "react";
import { placeBet } from "@/services/market";
import { useWallet } from "@/hooks/useWallet";
import type { TransactionResult, AppError } from "@/types";

export type TxStage =
  | "idle"
  | "building"
  | "signing"
  | "submitting"
  | "confirmed"
  | "failed";

export interface OptimisticBet {
  id: string;
  marketId: number;
  isYes: boolean;
  amount: number;
  status: "pending" | "confirmed" | "failed";
  createdAt: number;
}

interface UseBetResult {
  submit: (
    marketId: number,
    isYes: boolean,
    amount: number,
    minAcceptableOdds?: number
  ) => Promise<void>;
  result: TransactionResult | null;
  loading: boolean;
  stage: TxStage;
  error: string | null;
  optimisticBet: OptimisticBet | null;
  reset: () => void;
}

export function useBet(): UseBetResult {
  const { publicKey, signTransaction } = useWallet();
  const [result, setResult] = useState<TransactionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<TxStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [optimisticBet, setOptimisticBet] = useState<OptimisticBet | null>(
    null
  );

  const submit = useCallback(
    async (
      marketId: number,
      isYes: boolean,
      amount: number,
      minAcceptableOdds?: number
    ) => {
      if (!publicKey) {
        setError("Wallet not connected");
        return;
      }

      setLoading(true);
      setError(null);
      setResult(null);
      setStage("building");

      // Optimistically render the bet as soon as the user signs, so the
      // betting history and odds preview update instantly instead of waiting
      // for ledger consensus.
      const optimisticId = `optimistic-${marketId}-${Date.now()}`;
      setOptimisticBet({
        id: optimisticId,
        marketId,
        isYes,
        amount,
        status: "pending",
        createdAt: Date.now(),
      });

      try {
        setStage("signing");

        const txResult = await placeBet(
          publicKey,
          marketId,
          isYes,
          amount,
          signTransaction,
          minAcceptableOdds
        );

        setStage("submitting");

        if (txResult.success) {
          setStage("confirmed");
          setResult(txResult);
          // Reconcile the optimistic entry once the on-chain event confirms.
          setOptimisticBet((prev) =>
            prev && prev.id === optimisticId
              ? { ...prev, status: "confirmed" }
              : prev
          );
        } else {
          setStage("failed");
          setError(txResult.error || "Transaction failed");
          setResult(txResult);
          // Roll back the optimistic entry on failure.
          setOptimisticBet((prev) =>
            prev && prev.id === optimisticId ? null : prev
          );
        }
      } catch (err) {
        setStage("failed");
        console.error("[iPredict] useBet error:", err);
        let message: string;
        if (isAppError(err)) {
          // Show details if available for more useful debugging
          message = err.details && err.details !== err.message
            ? `${err.message} — ${err.details}`
            : err.message;
        } else if (err instanceof Error) {
          message = err.message;
        } else {
          message = String(err) || "Unknown error";
        }
        setError(message);
        // Roll back the optimistic entry on error.
        setOptimisticBet((prev) =>
          prev && prev.id === optimisticId ? null : prev
        );
      } finally {
        setLoading(false);
      }
    },
    [publicKey, signTransaction]
  );

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
    setStage("idle");
    setOptimisticBet(null);
  }, []);

  return { submit, result, loading, stage, error, optimisticBet, reset };
}

function isAppError(err: unknown): err is AppError {
  return (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    "message" in err
  );
}

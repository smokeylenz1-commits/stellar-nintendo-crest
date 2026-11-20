"use client";

import { useState, useCallback } from "react";
import { placeBet } from "@/services/market";
import { useWallet } from "@/hooks/useWallet";
import type { TransactionResult, AppError } from "@/types";
import type { PreSimulationResult } from "@/services/soroban";

export type TxStage =
  | "idle"
  | "simulating"
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
  /** Estimated Soroban resource fee from pre-flight simulation (in XLM). */
  estimatedFeeXLM: string | null;
  /** Warning from pre-flight simulation when the tx is predicted to revert. */
  simulationWarning: string | null;
  optimisticBet: OptimisticBet | null;
  reset: () => void;
}

export function useBet(): UseBetResult {
  const { publicKey, signTransaction } = useWallet();
  const [result, setResult] = useState<TransactionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<TxStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [estimatedFeeXLM, setEstimatedFeeXLM] = useState<string | null>(null);
  const [simulationWarning, setSimulationWarning] = useState<string | null>(null);
  const [optimisticBet, setOptimisticBet] = useState<OptimisticBet | null>(null);

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
      setSimulationWarning(null);
      setEstimatedFeeXLM(null);
      setStage("simulating");

      const optimisticId = `optimistic-${marketId}-${Date.now()}`;

      try {
        // The onSimulated callback fires after pre-flight simulation and
        // before the wallet modal opens. We use it to:
        //   1. Surface the estimated resource fee in the UI.
        //   2. Display an explicit warning if simulation predicts a revert,
        //      and block the wallet prompt so the user avoids a wasted fee.
        const onSimulated = async (sim: PreSimulationResult): Promise<boolean> => {
          setEstimatedFeeXLM(sim.estimatedFeeXLM);

          if (!sim.success && sim.simulationError) {
            setSimulationWarning(sim.simulationError);
            setLoading(false);
            setStage("failed");
            setError(
              `Transaction would revert on-chain — no fee charged. Reason: ${sim.simulationError}`
            );
            return false; // block wallet popup
          }

          // Success: advance to building stage so the UI shows "Preparing tx…"
          setStage("building");
          return true;
        };

        // Optimistically render the bet as soon as the user signs, so the
        // betting history and odds preview update instantly instead of waiting
        // for ledger consensus.
        setOptimisticBet({
          id: optimisticId,
          marketId,
          isYes,
          amount,
          status: "pending",
          createdAt: Date.now(),
        });

        setStage("signing");

        const txResult = await placeBet(
          publicKey,
          marketId,
          isYes,
          amount,
          signTransaction,
          minAcceptableOdds,
          onSimulated
        );

        setStage("submitting");

        if (txResult.success) {
          setStage("confirmed");
          setResult(txResult);
          setOptimisticBet((prev) =>
            prev && prev.id === optimisticId
              ? { ...prev, status: "confirmed" }
              : prev
          );
        } else {
          setStage("failed");
          setError(txResult.error || "Transaction failed");
          setResult(txResult);
          setOptimisticBet((prev) =>
            prev && prev.id === optimisticId ? null : prev
          );
        }
      } catch (err) {
        setStage("failed");
        console.error("[iPredict] useBet error:", err);
        let message: string;
        if (isAppError(err)) {
          message = err.details && err.details !== err.message
            ? `${err.message} — ${err.details}`
            : err.message;
        } else if (err instanceof Error) {
          message = err.message;
        } else {
          message = String(err) || "Unknown error";
        }
        setError(message);
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
    setEstimatedFeeXLM(null);
    setSimulationWarning(null);
    setOptimisticBet(null);
  }, []);

  return {
    submit,
    result,
    loading,
    stage,
    error,
    estimatedFeeXLM,
    simulationWarning,
    optimisticBet,
    reset,
  };
}

function isAppError(err: unknown): err is AppError {
  return (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    "message" in err
  );
}

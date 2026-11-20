"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useMarket } from "@/hooks/useMarket";
import { useClaim } from "@/hooks/useClaim";
import { useWallet } from "@/hooks/useWallet";
import { useToken } from "@/hooks/useToken";
import { pollMarketEvents } from "@/services/events";
import { getXlmBalance } from "@/services/soroban";
import { displayXLM, formatXLM, calculatePayout, truncateAddress } from "@/utils/helpers";
import {
  WIN_POINTS,
  LOSE_POINTS,
  WIN_TOKENS,
  LOSE_TOKENS,
} from "@/config/network";
import MarketImage from "@/components/market/MarketImage";
import OddsBar from "@/components/market/OddsBar";
import BettingPanel from "@/components/market/BettingPanel";
import CountdownTimer from "@/components/market/CountdownTimer";
import Badge from "@/components/ui/Badge";
import Skeleton from "@/components/ui/Skeleton";
import TxProgress from "@/components/ui/TxProgress";
import ErrorBoundary from "@/components/ui/ErrorBoundary";
import type { MarketEvent } from "@/types";
import { FiClock, FiUsers, FiTrendingUp, FiAward, FiArrowLeft, FiAlertTriangle } from "react-icons/fi";
import Link from "next/link";

function getStatusBadge(market: { resolved: boolean; outcome: boolean; cancelled: boolean }) {
  if (market.cancelled) return { variant: "cancelled" as const, label: "Cancelled" };
  if (market.resolved) return market.outcome
    ? { variant: "won" as const, label: "Resolved YES" }
    : { variant: "lost" as const, label: "Resolved NO" };
  return { variant: "active" as const, label: "Active" };
}

function formatChallengeRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

export default function MarketDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const marketId = Number(params.id);
  const { market, userBet, loading, error, refetch } = useMarket(marketId);
  const { publicKey } = useWallet();
  const { data: tokenData } = useToken(publicKey ?? undefined);
  const { submit: claimReward, loading: claiming, stage: claimStage, error: claimError, reset: resetClaim } = useClaim();

  const [events, setEvents] = useState<MarketEvent[]>([]);
  const [xlmBalance, setXlmBalance] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // Fetch native XLM balance for betting
  useEffect(() => {
    if (!publicKey) {
      setXlmBalance(0);
      return;
    }
    let mounted = true;
    getXlmBalance(publicKey).then((bal) => {
      if (mounted) setXlmBalance(bal);
    });
    return () => { mounted = false; };
  }, [publicKey]);

  // Fetch events
  useEffect(() => {
    let mounted = true;
    pollMarketEvents().then((evts) => {
      if (mounted) setEvents(evts.filter((e) => e.marketId === marketId).slice(0, 10));
    }).catch(() => { });
    return () => { mounted = false; };
  }, [marketId]);

  // Real-time tick for the optimistic resolution challenge window
  const challengeWindowEnd = (market as any)?.disputeWindowEnd as number | undefined;
  const challengeWindowActive = !!challengeWindowEnd && challengeWindowEnd > now;

  useEffect(() => {
    if (!challengeWindowEnd) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [challengeWindowEnd]);

  // Auto-refresh market status when the challenge window closes
  useEffect(() => {
    if (!challengeWindowEnd) return;
    if (challengeWindowEnd <= now) {
      refetch();
    }
  }, [challengeWindowEnd, now, refetch]);

  const handleClaim = useCallback(async () => {
    await claimReward(marketId);
    refetch();
  }, [claimReward, marketId, refetch]);

  const balance = xlmBalance;

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-12 space-y-6">
        <Skeleton width="6rem" height="1rem" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-4">
            <Skeleton height="14rem" className="rounded-2xl" />
            <Skeleton height="2rem" width="70%" />
            <Skeleton height="1.5rem" className="rounded-full" />
            <div className="grid grid-cols-3 gap-3">
              <Skeleton height="4rem" className="rounded-xl" />
              <Skeleton height="4rem" className="rounded-xl" />
              <Skeleton height="4rem" className="rounded-xl" />
            </div>
          </div>
          <div className="space-y-4">
            <Skeleton height="16rem" className="rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !market) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-12">
        <div className="card text-center py-10">
          <p className="text-accent-red mb-2">Failed to load market</p>
          <p className="text-sm text-slate-500">{error || "Market not found"}</p>
          <Link href="/markets" className="btn-secondary text-sm mt-4 inline-flex items-center gap-2">
            <FiArrowLeft className="w-4 h-4" /> Back to Markets
          </Link>
        </div>
      </div>
    );
  }

  const status = getStatusBadge(market);
  const totalPool = market.totalYes + market.totalNo;
  const yesPercent = totalPool > 0 ? Math.round((market.totalYes / totalPool) * 100) : 50;
  const noPercent = 100 - yesPercent;

  // Claim logic
  const isResolved = market.resolved || market.cancelled;
  const hasBet = !!userBet;
  const won = market.resolved && userBet ? market.outcome === userBet.isYes : false;
  const canClaim = hasBet && isResolved && !userBet!.claimed;

  const winnerPayout = won && userBet
    ? calculatePayout(
      userBet.amount,
      userBet.isYes ? market.totalYes : market.totalNo,
      totalPool
    )
    : 0;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 sm:py-12">
      {/* Back nav */}
      <Link
        href="/markets"
        className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors mb-6"
      >
        <FiArrowLeft className="w-4 h-4" /> All Markets
      </Link>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Market info */}
        <div className="lg:col-span-2 space-y-6">
          <ErrorBoundary fallbackTitle="Market info failed to load">
            {/* Header */}
            <div className="card overflow-hidden p-0">
              <div className="relative h-48 sm:h-64">
                <MarketImage
                  src={market.imageUrl}
                  alt={market.question}
                  className="w-full h-full"
                  rounded="top"
                />
                <div className="absolute top-4 left-4">
                  <Badge variant={status.variant} showIcon>
                    {status.label}
                  </Badge>
                </div>
              </div>
              <div className="p-6">
                <h1 className="font-heading text-2xl sm:text-3xl font-bold mb-4">
                  {market.question}
                </h1>

                {/* Optimistic resolution challenge window */}
                {challengeWindowActive && (
                  <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <FiAlertTriangle className="w-4 h-4 text-amber-400" />
                      <span className="font-heading font-semibold text-amber-300">
                        Challenge Window Closes in {formatChallengeRemaining(challengeWindowEnd! - now)}
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-slate-700 overflow-hidden">
                      <div
                        className="h-full bg-amber-400 transition-all duration-1000 ease-linear"
                        style={{
                          width: `${Math.min(
                            100,
                            Math.max(
                              0,
                              ((challengeWindowEnd! - now) / (24 * 60 * 60 * 1000)) * 100
                            )
                          )}%`,
                        }}
                      />
                    </div>
                    {(market as any)?.canChallenge && (
                      <button
                        type="button"
                        className="btn-secondary text-sm mt-3 inline-flex items-center gap-2"
                        onClick={() => refetch()}
                      >
                        <FiAlertTriangle className="w-4 h-4" /> Challenge Outcome
                      </button>
                    )}
                  </div>
                )}

                {/* Countdown */}
                {!market.resolved && !market.cancelled && (
                  <div className="flex items-center gap-2 mb-4">
                    <FiClock className="w-4 h-4 text-slate-400" />
                    <CountdownTimer endTime={market.endTime} />
                  </div>
                )}

                {/* Odds */}
                <OddsBar
                  yesPercent={yesPercent}
                  noPercent={noPercent}
                  size="lg"
                  showLabels
                />
              </div>
            </div>

            {/* Stats Row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="card py-4 text-center">
                <p className="text-xs text-slate-500 mb-1">Total Pool</p>
                <p className="font-heading font-bold">{displayXLM(totalPool)}</p>
              </div>
              <div className="card py-4 text-center">
                <p className="text-xs text-slate-500 mb-1">YES Pool</p>
                <p className="font-heading font-bold text-accent-green">{displayXLM(market.totalYes)}</p>
              </div>
              <div className="card py-4 text-center">
                <p className="text-xs text-slate-500 mb-1">NO Pool</p>
                <p className="font-heading font-bold text-accent-red">{displayXLM(market.totalNo)}</p>
              </div>
              <div className="card py-4 text-center">
                <p className="text-xs text-slate-500 mb-1">Bettors</p>
                <p className="font-heading font-bold flex items-center justify-center gap-1">
                  <FiUsers className="w-4 h-4 text-slate-500" /> {market.betCount}
                </p>
              </div>
            </div>
          </ErrorBoundary>

          {/* User's existing

/* … truncated 6118 chars — edit only what you need near the top … */

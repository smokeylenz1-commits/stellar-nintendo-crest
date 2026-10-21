import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { fetchUserBets } from '@/lib/api/bets';
import { fetchUserBonds } from '@/lib/api/bonds';
import { Bet } from '@/types/bet';
import { Bond, BondStatus } from '@/types/bond';
import { formatXlm } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Spinner } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';

interface BetHistoryProps {
  address: string;
}

type ProfileTab = 'bets' | 'bonds';

const BOND_STATUS_LABELS: Record<BondStatus, string> = {
  escrowed: 'Escrowed',
  returned: 'Returned with reward',
  slashed: 'Slashed',
};

const BOND_STATUS_VARIANTS: Record<BondStatus, 'warning' | 'success' | 'danger'> = {
  escrowed: 'warning',
  returned: 'success',
  slashed: 'danger',
};

const BOND_ROLE_LABELS: Record<Bond['role'], string> = {
  submitter: 'Submitter',
  challenger: 'Challenger',
};

export function BetHistory({ address }: BetHistoryProps) {
  const [activeTab, setActiveTab] = useState<ProfileTab>('bets');

  const {
    data: bets,
    isLoading: isLoadingBets,
    isError: isBetsError,
  } = useQuery({
    queryKey: ['userBets', address],
    queryFn: () => fetchUserBets(address),
    enabled: Boolean(address),
  });

  const {
    data: bonds,
    isLoading: isLoadingBonds,
    isError: isBondsError,
  } = useQuery({
    queryKey: ['userBonds', address],
    queryFn: () => fetchUserBonds(address),
    enabled: Boolean(address),
  });

  return (
    <section className="space-y-4">
      <div className="flex gap-2 border-b border-gray-200" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'bets'}
          onClick={() => setActiveTab('bets')}
          className={`px-4 py-2 text-sm font-medium ${
            activeTab === 'bets'
              ? 'border-b-2 border-indigo-600 text-indigo-600'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Bet History
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'bonds'}
          onClick={() => setActiveTab('bonds')}
          className={`px-4 py-2 text-sm font-medium ${
            activeTab === 'bonds'
              ? 'border-b-2 border-indigo-600 text-indigo-600'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Oracle Bonds
        </button>
      </div>

      {activeTab === 'bets' && (
        <div>
          {isLoadingBets && <Spinner />}
          {isBetsError && (
            <p className="text-sm text-red-600">Failed to load bet history.</p>
          )}
          {!isLoadingBets && !isBetsError && bets && bets.length === 0 && (
            <EmptyState message="No bets placed yet." />
          )}
          {!isLoadingBets && !isBetsError && bets && bets.length > 0 && (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-gray-500">
                  <th className="py-2">Market</th>
                  <th className="py-2">Outcome</th>
                  <th className="py-2">Amount (XLM)</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {bets.map((bet: Bet) => (
                  <tr key={bet.id} className="border-b border-gray-100">
                    <td className="py-2">
                      <Link
                        href={`/markets/${bet.marketId}`}
                        className="text-indigo-600 hover:underline"
                      >
                        {bet.marketTitle}
                      </Link>
                    </td>
                    <td className="py-2">{bet.outcome}</td>
                    <td className="py-2">{formatXlm(bet.amount)}</td>
                    <td className="py-2">{bet.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeTab === 'bonds' && (
        <div>
          {isLoadingBonds && <Spinner />}
          {isBondsError && (
            <p className="text-sm text-red-600">Failed to load oracle bonds.</p>
          )}
          {!isLoadingBonds && !isBondsError && bonds && bonds.length === 0 && (
            <EmptyState message="No oracle bonds posted yet." />
          )}
          {!isLoadingBonds && !isBondsError && bonds && bonds.length > 0 && (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-gray-500">
                  <th className="py-2">Market</th>
                  <th className="py-2">Role</th>
                  <th className="py-2">Bond (XLM)</th>
                  <th className="py-2">Status</th>
                  <th className="py-2">Transaction</th>
                </tr>
              </thead>
              <tbody>
                {bonds.map((bond: Bond) => (
                  <tr key={bond.id} className="border-b border-gray-100">
                    <td className="py-2">
                      <Link
                        href={`/markets/${bond.marketId}`}
                        className="text-indigo-600 hover:underline"
                      >
                        {bond.marketTitle}
                      </Link>
                    </td>
                    <td className="py-2">{BOND_ROLE_LABELS[bond.role]}</td>
                    <td className="py-2">{formatXlm(bond.amount)}</td>
                    <td className="py-2">
                      <Badge variant={BOND_STATUS_VARIANTS[bond.status]}>
                        {BOND_STATUS_LABELS[bond.status]}
                      </Badge>
                    </td>
                    <td className="py-2">
                      <a
                        href={`https://stellar.expert/explorer/public/tx/${bond.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-600 hover:underline"
                      >
                        {bond.txHash.slice(0, 8)}…{bond.txHash.slice(-6)}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

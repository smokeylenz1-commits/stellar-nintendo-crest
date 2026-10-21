'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useWallet } from '@/hooks/useWallet';
import { useBetHistory } from '@/hooks/useBetHistory';
import { useBondHistory } from '@/hooks/useBondHistory';
import { BetHistoryTable } from '@/components/profile/BetHistoryTable';
import { BondHistoryTable } from '@/components/profile/BondHistoryTable';
import { ProfileHeader } from '@/components/profile/ProfileHeader';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';

type ProfileTab = 'bets' | 'bonds';

export default function ProfilePage() {
  const { address, isConnected } = useWallet();
  const [activeTab, setActiveTab] = useState<ProfileTab>('bets');

  const { bets, isLoading: betsLoading } = useBetHistory(address);
  const { bonds, isLoading: bondsLoading } = useBondHistory(address);

  if (!isConnected || !address) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <h1 className="text-2xl font-semibold">Connect your wallet</h1>
        <p className="text-muted-foreground">
          Connect a Stellar wallet to view your profile and bond positions.
        </p>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 space-y-8">
      <ProfileHeader address={address} />

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as ProfileTab)}>
        <TabsList>
          <TabsTrigger value="bets">Bet History</TabsTrigger>
          <TabsTrigger value="bonds">Oracle Bonds</TabsTrigger>
        </TabsList>

        <TabsContent value="bets">
          <BetHistoryTable bets={bets} isLoading={betsLoading} />
        </TabsContent>

        <TabsContent value="bonds">
          <BondHistoryTable bonds={bonds} isLoading={bondsLoading} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

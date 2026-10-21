'use client';

import { useMemo, useState } from 'react';

const REFERRAL_BASE = 'https://ipredict.app/referrals';
const SHARE_COPY =
  'I\u2019m earning 0.5% on every bet my friends place on iPredict. Join with my referral link and start predicting on-chain:';

function buildReferralLink(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) return REFERRAL_BASE;
  return `${REFERRAL_BASE}?ref=${encodeURIComponent(trimmed)}`;
}

function buildShareText(link: string): string {
  return `${SHARE_COPY} ${link}`;
}

function buildOgImageUrl(address: string, displayName: string, earnings: string): string {
  const params = new URLSearchParams();
  if (address.trim()) params.set('ref', address.trim());
  if (displayName.trim()) params.set('name', displayName.trim());
  if (earnings.trim()) params.set('earnings', earnings.trim());
  const query = params.toString();
  return `/api/og/referral${query ? `?${query}` : ''}`;
}

export default function ReferralsPage() {
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [earnings, setEarnings] = useState('');
  const [copied, setCopied] = useState(false);

  const referralLink = useMemo(() => buildReferralLink(address), [address]);
  const shareText = useMemo(() => buildShareText(referralLink), [referralLink]);
  const ogImageUrl = useMemo(
    () => buildOgImageUrl(address, displayName, earnings),
    [address, displayName, earnings],
  );

  const shareTargets = [
    {
      label: 'Share on X',
      href: `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`,
    },
    {
      label: 'Share on Telegram',
      href: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent(shareText)}`,
    },
    {
      label: 'Share on WhatsApp',
      href: `https://wa.me/?text=${encodeURIComponent(shareText)}`,
    },
  ];

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(referralLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">Referral link generator</h1>
        <p className="text-sm text-gray-500">
          Earn 0.5% on every bet your invitees place. Generate your link and share it with a
          branded preview card.
        </p>
      </header>

      <section className="flex flex-col gap-4 rounded-xl border border-gray-200 p-6">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Your wallet address
          <input
            className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm"
            placeholder="0x..."
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Display name (for share card)
            <input
              className="rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="Satoshi"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Earnings (for share card)
            <input
              className="rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="1.24 ETH"
              value={earnings}
              onChange={(event) => setEarnings(event.target.value)}
            />
          </label>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Your referral link</span>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              readOnly
              className="flex-1 rounded-md border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-sm"
              value={referralLink}
            />
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white"
            >
              {copied ? 'Copied!' : 'Copy link'}
            </button>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-4 rounded-xl border border-gray-200 p-6">
        <h2 className="text-lg font-semibold">Share your referral</h2>
        <div className="flex flex-wrap gap-3">
          {shareTargets.map((target) => (
            <a
              key={target.label}
              href={target.href}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50"
            >
              {target.label}
            </a>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4 rounded-xl border border-gray-200 p-6">
        <h2 className="text-lg font-semibold">Share preview card</h2>
        <p className="text-sm text-gray-500">
          This branded OpenGraph image is generated dynamically and shown when your link is shared
          on X, Telegram, or WhatsApp.
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={ogImageUrl}
          alt="Referral share preview"
          className="w-full rounded-lg border border-gray-200"
        />
      </section>
    </main>
  );
}

// Referral link generator + social share helpers for the /referrals route.
// Issue #93: one-click sharing with pre-populated marketing copy and a
// dynamic OpenGraph preview endpoint that renders branded share cards.

export type SocialPlatform = "x" | "telegram" | "whatsapp";

export interface ReferralShareContext {
  /** Referrer wallet address used to build the referral link. */
  address: string;
  /** Optional display name shown in the share copy and OG card. */
  displayName?: string;
  /** Optional earnings (in the app's base unit) shown on the OG card. */
  earnings?: string | number;
  /** Base URL of the app; defaults to the current origin when available. */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://ipredict.app";

function resolveBaseUrl(baseUrl?: string): string {
  if (baseUrl) return baseUrl.replace(/\/+$/, "");
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return DEFAULT_BASE_URL;
}

/**
 * Build the canonical referral link for a wallet address.
 * e.g. https://ipredict.app/referrals?ref=0xabc...
 */
export function buildReferralLink(address: string, baseUrl?: string): string {
  const origin = resolveBaseUrl(baseUrl);
  const params = new URLSearchParams({ ref: address });
  return `${origin}/referrals?${params.toString()}`;
}

/**
 * Build the dynamic OpenGraph preview endpoint URL. Social crawlers hit this
 * route to render a branded share card with the referrer's name and earnings.
 */
export function buildOgImageUrl(ctx: ReferralShareContext): string {
  const origin = resolveBaseUrl(ctx.baseUrl);
  const params = new URLSearchParams({ address: ctx.address });
  if (ctx.displayName) params.set("name", ctx.displayName);
  if (ctx.earnings !== undefined && ctx.earnings !== null) {
    params.set("earnings", String(ctx.earnings));
  }
  return `${origin}/api/og/referral?${params.toString()}`;
}

/** Pre-populated marketing copy shared alongside the referral link. */
export function buildShareMessage(ctx: ReferralShareContext): string {
  const who = ctx.displayName ? `${ctx.displayName} is` : "I'm";
  return (
    `${who} earning on iPredict! Predict on-chain and earn 0.5% on every ` +
    `bet your invitees place. Join with my referral link:`
  );
}

/**
 * Build a one-click share URL for the given platform, pre-populating both the
 * marketing copy and the referral link.
 */
export function buildShareUrl(
  platform: SocialPlatform,
  ctx: ReferralShareContext,
): string {
  const link = buildReferralLink(ctx.address, ctx.baseUrl);
  const message = buildShareMessage(ctx);
  const text = `${message} ${link}`;

  switch (platform) {
    case "x":
      return `https://twitter.com/intent/tweet?${new URLSearchParams({
        text: message,
        url: link,
      }).toString()}`;
    case "telegram":
      return `https://t.me/share/url?${new URLSearchParams({
        url: link,
        text: message,
      }).toString()}`;
    case "whatsapp":
      return `https://wa.me/?text=${encodeURIComponent(text)}`;
    default: {
      const _exhaustive: never = platform;
      return _exhaustive;
    }
  }
}

/**
 * Open a platform share dialog in a popup window. Falls back to a new tab when
 * the popup is blocked so sharing still works.
 */
export function openShareWindow(
  platform: SocialPlatform,
  ctx: ReferralShareContext,
): void {
  const url = buildShareUrl(platform, ctx);
  if (typeof window === "undefined") return;
  const popup = window.open(url, "_blank", "noopener,noreferrer,width=600,height=600");
  if (!popup) {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** Copy the referral link to the clipboard, returning success state. */
export async function copyReferralLink(
  address: string,
  baseUrl?: string,
): Promise<boolean> {
  const link = buildReferralLink(address, baseUrl);
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(link);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

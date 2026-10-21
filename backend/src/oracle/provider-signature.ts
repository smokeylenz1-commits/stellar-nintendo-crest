/**
 * Signature verification for external oracle providers (#40).
 *
 * A provider signs a challenge that binds the market, the outcome and a timestamp, so a captured
 * signature cannot be replayed for another market or after the freshness window. The signature
 * is checked against the provider's registered Stellar ed25519 public key. The primitive is
 * injected: the Stellar SDK's `Keypair.verify` is the intended implementation. An invalid or
 * stale payload is rejected with HTTP 401.
 */

export const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

export interface ProviderSubmission {
  marketId: number;
  outcome: "YES" | "NO";
  signature: string;
  provider: string;
  signedAt: number;
}

export interface ProviderKeyStore {
  publicKeyFor(provider: string): string | undefined;
}

export type Ed25519Verify = (publicKey: string, message: string, signatureBase64: string) => boolean;

/** The exact bytes a provider signs. */
export function challengeFor(submission: Pick<ProviderSubmission, "marketId" | "outcome" | "signedAt">): string {
  return `iPredict|oracle|${submission.marketId}|${submission.outcome}|${submission.signedAt}`;
}

export type VerifyResult = { ok: true } | { ok: false; status: 401; reason: string };

export function verifyProviderSubmission(
  submission: ProviderSubmission,
  keys: ProviderKeyStore,
  verify: Ed25519Verify,
  now: number = Date.now(),
): VerifyResult {
  const reject = (reason: string): VerifyResult => ({ ok: false, status: 401, reason });

  if (!submission.signature) {
    return reject("unsigned submission");
  }
  const publicKey = keys.publicKeyFor(submission.provider);
  if (!publicKey) {
    return reject("unknown provider");
  }
  if (Math.abs(now - submission.signedAt) > MAX_SIGNATURE_AGE_MS) {
    return reject("signature is stale or from the future");
  }
  if (!verify(publicKey, challengeFor(submission), submission.signature)) {
    return reject("signature does not match the provider key");
  }
  return { ok: true };
}

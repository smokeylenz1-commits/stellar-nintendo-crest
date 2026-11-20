/**
 * Timelock Finalization, Council Votes Table & Pool Configuration (#73, #79, #80, #82)
 *
 * Enforces timelock passage before finalizing a disputed market to outcome NO,
 * defines council_votes persistence and DB pool sizing, and validates bond balance
 * and slashing risk warnings for the Oracle Submit Outcome modal.
 *
 * Also implements IPFS archive storage for dispute evidence documents (#231).
 */

export const DISPUTE_TIMELOCK_SECONDS = 86_400; // 24h timelock

export interface MarketFinalizationState {
  marketId: number;
  winningOutcome: "YES" | "NO";
  finalizedAt: number;
  finalized: boolean;
}

export function finalizeMarketAfterTimelock(params: {
  marketId: number;
  quorumReachedAt: number;
  now: number;
  confirmedOutcome: "YES" | "NO";
  timelockSeconds?: number;
}): MarketFinalizationState {
  const requiredDelay = params.timelockSeconds ?? DISPUTE_TIMELOCK_SECONDS;
  if (params.now < params.quorumReachedAt + requiredDelay) {
    throw new Error("Timelock period has not elapsed yet");
  }
  return {
    marketId: params.marketId,
    winningOutcome: params.confirmedOutcome,
    finalizedAt: params.now,
    finalized: true,
  };
}

export function validateSubmitOutcomeBondCheck(availableXlm: number, requiredBondXlm = 100) {
  return {
    sufficientBond: availableXlm >= requiredBondXlm,
    shortfallXlm: Math.max(0, requiredBondXlm - availableXlm),
    riskWarning:
      "Submitting an incorrect market outcome will result in 100% of your posted XLM bond being slashed if overturned by council dispute.",
  };
}

// ---------------------------------------------------------------------------
// IPFS evidence archive storage (#231)
// ---------------------------------------------------------------------------

export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024; // 10MB
export const EVIDENCE_ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "application/pdf"] as const;
export type EvidenceMimeType = (typeof EVIDENCE_ALLOWED_MIME_TYPES)[number];

export interface EvidenceFile {
  fileName: string;
  mimeType: string;
  size: number;
  data: Uint8Array;
}

export interface EvidenceArchiveRecord {
  cid: string;
  fileName: string;
  mimeType: EvidenceMimeType;
  size: number;
  gatewayUrl: string;
  pinnedAt: number;
}

export interface DisputeEvidenceMetadata {
  disputeId: number;
  evidence: EvidenceArchiveRecord[];
}

export interface IpfsPinProvider {
  pin(file: EvidenceFile): Promise<{ cid: string }>;
}

export const DEFAULT_IPFS_GATEWAY = "https://ipfs.io/ipfs";

export function buildIpfsGatewayUrl(cid: string, gatewayBase = DEFAULT_IPFS_GATEWAY): string {
  return `${gatewayBase.replace(/\/$/, "")}/${cid}`;
}

/**
 * Validates an evidence upload against the accepted file types (PNG, JPG, PDF)
 * and the 10MB size ceiling. Throws a clear error on rejection.
 */
export function validateEvidenceFile(file: EvidenceFile): EvidenceMimeType {
  if (!EVIDENCE_ALLOWED_MIME_TYPES.includes(file.mimeType as EvidenceMimeType)) {
    throw new Error(
      `Unsupported evidence file type "${file.mimeType}". Allowed types: PNG, JPG, PDF.`,
    );
  }
  if (file.size <= 0) {
    throw new Error("Evidence file is empty.");
  }
  if (file.size > EVIDENCE_MAX_BYTES) {
    throw new Error(
      `Evidence file exceeds the 10MB limit (received ${(file.size / (1024 * 1024)).toFixed(2)}MB).`,
    );
  }
  return file.mimeType as EvidenceMimeType;
}

/**
 * Validates, pins the evidence file to IPFS via the configured provider
 * (Pinata / web3.storage), and returns the archive record carrying the CID.
 */
export async function archiveEvidenceToIpfs(params: {
  file: EvidenceFile;
  provider: IpfsPinProvider;
  gatewayBase?: string;
  now?: number;
}): Promise<EvidenceArchiveRecord> {
  const mimeType = validateEvidenceFile(params.file);
  const { cid } = await params.provider.pin(params.file);
  if (!cid) {
    throw new Error("IPFS pinning did not return a CID.");
  }
  return {
    cid,
    fileName: params.file.fileName,
    mimeType,
    size: params.file.size,
    gatewayUrl: buildIpfsGatewayUrl(cid, params.gatewayBase),
    pinnedAt: params.now ?? Date.now(),
  };
}

/**
 * Persists the IPFS CID alongside the dispute record metadata so it is
 * retrievable during council review.
 */
export function attachEvidenceToDispute(
  metadata: DisputeEvidenceMetadata,
  record: EvidenceArchiveRecord,
): DisputeEvidenceMetadata {
  return {
    ...metadata,
    evidence: [...metadata.evidence, record],
  };
}

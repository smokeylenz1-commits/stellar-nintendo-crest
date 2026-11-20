/**
 * Challenger Outcome Dispute (200 XLM Bond), HTTP ETag Caching & Request Tracing (#57, #58, #64, #65)
 *
 * Handles Challenger disputing a proposed YES outcome to NO with a 200 XLM bond,
 * ETag / If-None-Match generation for market read endpoints, BetPlaced cache invalidation,
 * OpenAPI specification metadata, and X-Request-ID trace header propagation.
 *
 * Also supports IPFS archive storage for dispute evidence documents (#231):
 * validates PNG/JPG/PDF uploads up to 10MB, pins them via Pinata, and persists
 * the resulting CID alongside the dispute record for council review.
 */

import { createHash, randomUUID } from "crypto";

export const MINIMUM_CHALLENGER_BOND_XLM = 200;

export const MAX_EVIDENCE_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_EVIDENCE_MIME_TYPES = ["image/png", "image/jpeg", "application/pdf"] as const;
export type EvidenceMimeType = (typeof ALLOWED_EVIDENCE_MIME_TYPES)[number];

export interface DisputeEvidence {
  cid: string;
  fileName: string;
  mimeType: EvidenceMimeType;
  sizeBytes: number;
  gatewayUrl: string;
}

export interface ChallengerDisputeRecord {
  disputeId: number;
  marketId: number;
  challenger: string;
  challengedOutcome: "YES" | "NO";
  bondXlm: number;
  requestId: string;
  evidence?: DisputeEvidence[];
}

export function disputeProposedOutcomeToNo(params: {
  disputeId: number;
  marketId: number;
  currentProposedOutcome: "YES" | "NO";
  challenger: string;
  challengedOutcome: "YES" | "NO";
  bondXlm: number;
  requestId?: string;
  evidence?: DisputeEvidence[];
}): ChallengerDisputeRecord {
  if (params.bondXlm < MINIMUM_CHALLENGER_BOND_XLM) {
    throw new Error(`Challenger bond must be at least ${MINIMUM_CHALLENGER_BOND_XLM} XLM`);
  }
  if (params.challengedOutcome === params.currentProposedOutcome) {
    throw new Error("Challenged outcome must oppose the proposed outcome");
  }
  return {
    disputeId: params.disputeId,
    marketId: params.marketId,
    challenger: params.challenger,
    challengedOutcome: params.challengedOutcome,
    bondXlm: params.bondXlm,
    requestId: params.requestId || randomUUID(),
    ...(params.evidence && params.evidence.length > 0 ? { evidence: params.evidence } : {}),
  };
}

export function validateEvidenceFile(params: {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}): EvidenceMimeType {
  if (!ALLOWED_EVIDENCE_MIME_TYPES.includes(params.mimeType as EvidenceMimeType)) {
    throw new Error(
      `Unsupported evidence file type "${params.mimeType}". Allowed types: PNG, JPG, PDF`,
    );
  }
  if (params.sizeBytes <= 0) {
    throw new Error("Evidence file is empty");
  }
  if (params.sizeBytes > MAX_EVIDENCE_FILE_SIZE_BYTES) {
    throw new Error(
      `Evidence file exceeds the 10MB limit (received ${params.sizeBytes} bytes)`,
    );
  }
  return params.mimeType as EvidenceMimeType;
}

export function buildEvidenceGatewayUrl(cid: string, gatewayBase = "https://gateway.pinata.cloud/ipfs"): string {
  return `${gatewayBase.replace(/\/$/, "")}/${cid}`;
}

export async function pinEvidenceToIpfs(params: {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  data: Uint8Array | Buffer;
  pinataJwt?: string;
  fetchImpl?: typeof fetch;
}): Promise<DisputeEvidence> {
  const mimeType = validateEvidenceFile({
    fileName: params.fileName,
    mimeType: params.mimeType,
    sizeBytes: params.sizeBytes,
  });

  const pinataJwt = params.pinataJwt ?? process.env.PINATA_JWT;
  if (!pinataJwt) {
    throw new Error("PINATA_JWT is not configured; cannot pin evidence to IPFS");
  }

  const doFetch = params.fetchImpl ?? fetch;
  const form = new FormData();
  form.append("file", new Blob([params.data], { type: mimeType }), params.fileName);
  form.append("pinataMetadata", JSON.stringify({ name: params.fileName }));

  const response = await doFetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${pinataJwt}` },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`Pinata pin failed with status ${response.status}`);
  }

  const result = (await response.json()) as { IpfsHash?: string };
  if (!result.IpfsHash) {
    throw new Error("Pinata response did not include an IPFS CID");
  }

  return {
    cid: result.IpfsHash,
    fileName: params.fileName,
    mimeType,
    sizeBytes: params.sizeBytes,
    gatewayUrl: buildEvidenceGatewayUrl(result.IpfsHash),
  };
}

export function computeMarketETag(payload: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
  return `"${digest}"`;
}

export function invalidateMarketCacheKeysOnBetPlaced(marketId: number | string): string[] {
  return [
    `market:${marketId}:details`,
    `market:${marketId}:odds`,
    `market:${marketId}:bets`,
    "leaderboard:top",
  ];
}

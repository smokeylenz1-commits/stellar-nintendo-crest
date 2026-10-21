/**
 * Input sanitization helpers for user-created market content.
 *
 * Prevents stored XSS by stripping HTML/script payloads from market titles,
 * descriptions, and external evidence URLs before they are rendered or sent
 * to the backend/contract.
 */

export const MARKET_TITLE_MAX_LENGTH = 160;
export const MARKET_DESCRIPTION_MAX_LENGTH = 1000;

/**
 * Strip all HTML tags and decode a small set of common entities so that
 * payloads like `<img src=x onerror=alert(1)>` become inert text.
 */
export function stripHtml(input: string): string {
  if (typeof input !== 'string') {
    return '';
  }

  return input
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\u0000/g, '')
    .trim();
}

/**
 * Sanitize free-form market text: strip HTML, collapse whitespace, and
 * enforce the contract-level length limit.
 */
export function sanitizeMarketText(input: string, maxLength: number): string {
  const cleaned = stripHtml(input).replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, maxLength);
}

export function sanitizeMarketTitle(input: string): string {
  return sanitizeMarketText(input, MARKET_TITLE_MAX_LENGTH);
}

export function sanitizeMarketDescription(input: string): string {
  return sanitizeMarketText(input, MARKET_DESCRIPTION_MAX_LENGTH);
}

/**
 * Validate an external evidence/source URL. Only http(s) URLs are accepted;
 * malformed or dangerous schemes (javascript:, data:, etc.) are rejected.
 */
export function isValidEvidenceUrl(input: string): boolean {
  if (typeof input !== 'string' || input.trim() === '') {
    return false;
  }

  try {
    const url = new URL(input.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Sanitize an evidence URL, returning an empty string when invalid so callers
 * can safely omit the field.
 */
export function sanitizeEvidenceUrl(input: string): string {
  const trimmed = typeof input === 'string' ? input.trim() : '';
  return isValidEvidenceUrl(trimmed) ? trimmed : '';
}

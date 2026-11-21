/**
 * Shared notification helpers.
 *
 * Includes display-name sanitization for referral leaderboards to prevent
 * XSS injection and Unicode homoglyph impersonation attacks.
 */

const DISPLAY_NAME_PATTERN = /^[a-zA-Z0-9_-]{3,20}$/;

/**
 * Map of common Unicode confusables (Cyrillic, Greek, fullwidth, and other
 * lookalike characters) to their ASCII equivalents. Used to normalize names
 * before validation so lookalike characters cannot impersonate admins.
 */
const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic lookalikes
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041A': 'K', '\u041C': 'M',
  '\u041D': 'H', '\u041E': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T',
  '\u0425': 'X', '\u0423': 'Y', '\u0405': 'S', '\u0406': 'I', '\u0408': 'J',
  '\u0430': 'a', '\u0432': 'b', '\u0435': 'e', '\u043A': 'k', '\u043C': 'm',
  '\u043D': 'h', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0442': 't',
  '\u0445': 'x', '\u0443': 'y', '\u0455': 's', '\u0456': 'i', '\u0458': 'j',
  // Greek lookalikes
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H',
  '\u0399': 'I', '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O',
  '\u03A1': 'P', '\u03A4': 'T', '\u03A5': 'Y', '\u03A7': 'X', '\u03BF': 'o',
  '\u03B1': 'a', '\u03B5': 'e', '\u03B9': 'i', '\u03BA': 'k', '\u03BD': 'v',
  '\u03C1': 'p', '\u03C4': 't', '\u03C5': 'u', '\u03C7': 'x',
  // Fullwidth ASCII
  '\uFF21': 'A', '\uFF22': 'B', '\uFF23': 'C', '\uFF24': 'D', '\uFF25': 'E',
  '\uFF26': 'F', '\uFF27': 'G', '\uFF28': 'H', '\uFF29': 'I', '\uFF2A': 'J',
  '\uFF2B': 'K', '\uFF2C': 'L', '\uFF2D': 'M', '\uFF2E': 'N', '\uFF2F': 'O',
  '\uFF30': 'P', '\uFF31': 'Q', '\uFF32': 'R', '\uFF33': 'S', '\uFF34': 'T',
  '\uFF35': 'U', '\uFF36': 'V', '\uFF37': 'W', '\uFF38': 'X', '\uFF39': 'Y',
  '\uFF3A': 'Z', '\uFF41': 'a', '\uFF42': 'b', '\uFF43': 'c', '\uFF44': 'd',
  '\uFF45': 'e', '\uFF46': 'f', '\uFF47': 'g', '\uFF48': 'h', '\uFF49': 'i',
  '\uFF4A': 'j', '\uFF4B': 'k', '\uFF4C': 'l', '\uFF4D': 'm', '\uFF4E': 'n',
  '\uFF4F': 'o', '\uFF50': 'p', '\uFF51': 'q', '\uFF52': 'r', '\uFF53': 's',
  '\uFF54': 't', '\uFF55': 'u', '\uFF56': 'v', '\uFF57': 'w', '\uFF58': 'x',
  '\uFF59': 'y', '\uFF5A': 'z',
};

/**
 * Normalize Unicode homoglyphs to their ASCII equivalents.
 */
export function normalizeHomoglyphs(input: string): string {
  let result = '';
  for (const char of input) {
    result += HOMOGLYPH_MAP[char] ?? char;
  }
  return result;
}

/**
 * Strip HTML tags and script content from a string.
 */
export function stripHtml(input: string): string {
  return input
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, '');
}

/**
 * Sanitize a referral display name.
 *
 * Strips HTML/script tags, normalizes Unicode homoglyphs, then validates
 * against the whitelist `^[a-zA-Z0-9_-]{3,20}$`.
 *
 * @returns the sanitized name, or `null` if it is invalid.
 */
export function sanitizeDisplayName(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null;
  }

  const stripped = stripHtml(input).trim();
  const normalized = normalizeHomoglyphs(stripped);

  if (!DISPLAY_NAME_PATTERN.test(normalized)) {
    return null;
  }

  return normalized;
}

/**
 * Validate a referral display name without returning the sanitized value.
 */
export function isValidDisplayName(input: unknown): boolean {
  return sanitizeDisplayName(input) !== null;
}

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Next.js Edge Middleware — Security headers + CSP nonce injection
 *
 * Why middleware (not next.config.mjs headers()):
 *  next.config.mjs headers() runs at build-time and produces static header
 *  values. CSP script nonces MUST be unique per request (a static nonce is
 *  no better than 'unsafe-inline'). Middleware runs on every request in the
 *  Edge runtime, so it can generate a fresh cryptographic nonce and stamp
 *  it into both the CSP header and the HTML response body via
 *  x-nonce (read by the root layout).
 *
 * Content-Security-Policy design:
 *  default-src 'self'          — block everything unknown by default
 *  script-src  'self' 'nonce-…' — only scripts served from origin or carrying
 *                                 the per-request nonce (Next.js inlines a
 *                                 small bootstrap script; the nonce covers it)
 *  style-src   'self' 'unsafe-inline' fonts.googleapis.com
 *                              — 'unsafe-inline' needed for Tailwind's runtime
 *                                 style injection and CSS-in-JS; Google Fonts
 *                                 CSS is served from fonts.googleapis.com
 *  font-src    'self' fonts.gstatic.com data:
 *                              — actual font binary files come from gstatic
 *  img-src     'self' data: blob: https:
 *                              — user-uploaded market images are HTTPS URLs;
 *                                 blob: needed for wallet QR previews
 *  connect-src 'self' https: wss:
 *                              — Soroban RPC proxy (/api/rpc), Horizon, WS for
 *                                 wallet extensions (Freighter, xBull)
 *  worker-src  'self' blob:    — Freighter extension uses a service worker
 *  frame-src   'none'          — no iframes; prevents clickjacking
 *  object-src  'none'          — block Flash/plugins
 *  base-uri    'self'          — prevent base-tag injection
 *  form-action 'self'          — prevent form hijacking to external hosts
 *  upgrade-insecure-requests   — force HTTP→HTTPS for any stray mixed content
 */

export const config = {
  // Run on every page and API route. Skip static assets (_next/static, images,
  // favicons) which don't need security headers on each individual file response.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|logo.png|favicon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|woff2?|ttf|otf)$).*)",
  ],
};

/** Generate a cryptographically random nonce using the Web Crypto API. */
function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Convert to a hex string — safe as a nonce value in a header.
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function middleware(request: NextRequest): NextResponse {
  const nonce = generateNonce();

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}'`,
    // 'unsafe-inline' is required for Tailwind CSS runtime injection and
    // Next.js's CSS-in-JS; Google Fonts stylesheet comes from googleapis.com.
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    // Font binary files are served from gstatic; data: for inline SVG fonts.
    `font-src 'self' https://fonts.gstatic.com data:`,
    // Market images are HTTPS; blob: for wallet extension previews.
    `img-src 'self' data: blob: https:`,
    // Soroban RPC proxy lives at /api/rpc (same-origin). Wallet extensions
    // open WebSocket connections; Horizon uses HTTPS.
    `connect-src 'self' https: wss:`,
    // Freighter and xBull use service workers delivered as blobs.
    `worker-src 'self' blob:`,
    // No iframes anywhere on the app.
    `frame-src 'none'`,
    // Block Flash and other legacy plugins.
    `object-src 'none'`,
    // Prevent <base href="…"> injection attacks.
    `base-uri 'self'`,
    // Lock form submissions to same origin.
    `form-action 'self'`,
    // Force any HTTP sub-resources to HTTPS.
    `upgrade-insecure-requests`,
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  // Pass nonce to Server Components via a request header; the root layout
  // reads this via headers() and forwards it to the Next.js <Script> nonce prop.
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  // ── Content Security Policy ───────────────────────────────────────────────
  response.headers.set("Content-Security-Policy", csp);

  // ── Additional hardening headers ─────────────────────────────────────────
  // Prevent browsers from MIME-sniffing a response away from the declared type.
  response.headers.set("X-Content-Type-Options", "nosniff");

  // Deny all framing — belt-and-suspenders alongside frame-src 'none' in CSP.
  response.headers.set("X-Frame-Options", "DENY");

  // Enforce HTTPS for 1 year, include subdomains.
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains"
  );

  // Control referrer — leak only origin, never full URL.
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // Restrict browser features not used by the app.
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()"
  );

  // Expose the nonce to the client via a custom header so the root layout
  // can stamp it onto inline <script> tags rendered server-side.
  response.headers.set("x-nonce", nonce);

  return response;
}

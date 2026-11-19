# ── Stage 1: deps ─────────────────────────────────────────────────────────────
# Install production + dev dependencies in a separate layer so they can be
# cached independently from source changes.
FROM node:20-alpine AS deps

WORKDIR /app

# Install libc compatibility shims required by some native addons on Alpine.
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json ./
RUN npm ci

# ── Stage 2: builder ──────────────────────────────────────────────────────────
# Compile the Next.js application in standalone output mode.
# The resulting .next/standalone directory contains the minimal runtime —
# no node_modules directory is needed in the final image.
FROM node:20-alpine AS builder

WORKDIR /app

# Re-use the installed modules from the deps stage.
COPY --from=deps /app/node_modules ./node_modules

# Copy the full source tree.
COPY . .

# Build-time environment variables (non-secret).
# Override at build time with --build-arg if needed.
ARG NEXT_PUBLIC_NETWORK=mainnet
ARG NEXT_PUBLIC_APP_URL=https://ipredict-stellar.vercel.app
ENV NEXT_PUBLIC_NETWORK=${NEXT_PUBLIC_NETWORK}
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}

# Disable Next.js telemetry during the build.
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ── Stage 3: runner ───────────────────────────────────────────────────────────
# Minimal Alpine image that only ships what Next.js standalone output needs.
# Target image size: < 150 MB.
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Default port; override with the PORT env variable at runtime.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Create a non-root user and group for security.
RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 nextjs

# Copy only the files Next.js standalone output requires.
# .next/standalone  — the Node server + a minimal node_modules snapshot
# .next/static       — static JS/CSS chunks (served by Next.js or a CDN)
# public             — static assets (images, fonts, etc.)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static    ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public          ./public

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health 2>/dev/null || \
      wget -qO- http://localhost:3000/ >/dev/null 2>&1 || exit 1

# Start the standalone server.
CMD ["node", "server.js"]

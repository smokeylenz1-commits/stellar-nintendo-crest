# Standalone oracle worker container (issue #233)
# Runs oracle resolution + monitoring workers independently of the API web server.

FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy application sources needed by the oracle worker entrypoint.
COPY . .

# Run as a non-root user.
RUN addgroup -S oracle && adduser -S oracle -G oracle \
    && chown -R oracle:oracle /app
USER oracle

# Environment configuration (override at deploy time).
ENV ORACLE_WORKER_MODE=daemon \
    ORACLE_POLL_INTERVAL_MS=15000 \
    ORACLE_HEALTH_PORT=8081 \
    ORACLE_HEALTH_PATH=/healthz

EXPOSE 8081

# Comprehensive container health check against the worker's own health endpoint,
# independent of any web server HTTP lifecycle.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "const http=require('http');const port=process.env.ORACLE_HEALTH_PORT||8081;const path=process.env.ORACLE_HEALTH_PATH||'/healthz';const req=http.get({host:'127.0.0.1',port,path,timeout:4000},res=>{process.exit(res.statusCode===200?0:1)});req.on('error',()=>process.exit(1));req.on('timeout',()=>{req.destroy();process.exit(1)});"

# Independent entrypoint: runs the oracle daemon/workers directly, no web server.
CMD ["node", "dist/services/oracle-worker/entrypoint.js"]

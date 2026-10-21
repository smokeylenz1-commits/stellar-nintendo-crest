'use strict';

/**
 * Health probes backing the public status page (/status).
 *
 * Each probe returns a normalized component status so the status page can
 * render live network latency, RPC status, and indexer lag without knowing
 * the details of any individual upstream service.
 */

const DEFAULT_TIMEOUT_MS = 5000;

const COMPONENT_IDS = {
  HORIZON_RPC: 'stellar-horizon-rpc',
  INDEXER: 'chain-indexer',
  ORACLE_RESOLVERS: 'optimistic-oracle-resolvers',
  REST_API: 'backend-rest-api',
};

const STATUS = {
  OPERATIONAL: 'operational',
  DEGRADED: 'degraded',
  PARTIAL_OUTAGE: 'partial_outage',
  MAJOR_OUTAGE: 'major_outage',
};

const STATUS_RANK = {
  [STATUS.OPERATIONAL]: 0,
  [STATUS.DEGRADED]: 1,
  [STATUS.PARTIAL_OUTAGE]: 2,
  [STATUS.MAJOR_OUTAGE]: 3,
};

function nowIso() {
  return new Date().toISOString();
}

function resolveConfig(env) {
  const source = env || process.env || {};
  return {
    horizonUrl: source.STELLAR_HORIZON_URL || 'https://horizon.stellar.org',
    rpcUrl: source.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
    indexerUrl: source.INDEXER_HEALTH_URL || 'http://localhost:4001/health',
    oracleUrl: source.ORACLE_HEALTH_URL || 'http://localhost:4002/health',
    apiUrl: source.API_HEALTH_URL || 'http://localhost:3000/health',
    timeoutMs: Number(source.STATUS_PROBE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    indexerLagThresholdSeconds: Number(source.INDEXER_LAG_THRESHOLD_SECONDS) || 60,
    latencyDegradedMs: Number(source.LATENCY_DEGRADED_MS) || 1500,
  };
}

async function timedFetch(url, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
    });
    const latencyMs = Date.now() - startedAt;
    let body = null;
    try {
      body = await response.json();
    } catch (_err) {
      body = null;
    }
    return { ok: response.ok, statusCode: response.status, latencyMs, body };
  } catch (err) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: Date.now() - startedAt,
      body: null,
      error: err && err.message ? err.message : String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function component(id, name, status, details) {
  return {
    id,
    name,
    status,
    checkedAt: nowIso(),
    ...details,
  };
}

function statusFromLatency(result, latencyDegradedMs) {
  if (!result.ok) return STATUS.MAJOR_OUTAGE;
  if (result.latencyMs >= latencyDegradedMs) return STATUS.DEGRADED;
  return STATUS.OPERATIONAL;
}

async function probeHorizonRpc(config) {
  const [horizon, rpc] = await Promise.all([
    timedFetch(`${config.horizonUrl.replace(/\/$/, '')}/`, config.timeoutMs),
    timedFetch(config.rpcUrl, config.timeoutMs),
  ]);

  const horizonStatus = statusFromLatency(horizon, config.latencyDegradedMs);
  const rpcStatus = statusFromLatency(rpc, config.latencyDegradedMs);
  const status = STATUS_RANK[horizonStatus] >= STATUS_RANK[rpcStatus] ? horizonStatus : rpcStatus;

  return component(COMPONENT_IDS.HORIZON_RPC, 'Stellar Horizon / RPC Node', status, {
    latencyMs: Math.max(horizon.latencyMs, rpc.latencyMs),
    metrics: {
      horizonLatencyMs: horizon.latencyMs,
      horizonStatusCode: horizon.statusCode,
      rpcLatencyMs: rpc.latencyMs,
      rpcStatusCode: rpc.statusCode,
    },
  });
}

async function probeIndexer(config) {
  const result = await timedFetch(config.indexerUrl, config.timeoutMs);
  const lagSeconds =
    result.body && typeof result.body.lagSeconds === 'number' ? result.body.lagSeconds : null;

  let status = statusFromLatency(result, config.latencyDegradedMs);
  if (status === STATUS.OPERATIONAL && lagSeconds !== null && lagSeconds > config.indexerLagThresholdSeconds) {
    status = STATUS.DEGRADED;
  }

  return component(COMPONENT_IDS.INDEXER, 'Chain Indexer & Event Processing', status, {
    latencyMs: result.latencyMs,
    metrics: {
      indexerLagSeconds: lagSeconds,
      lagThresholdSeconds: config.indexerLagThresholdSeconds,
      statusCode: result.statusCode,
    },
  });
}

async function probeOracleResolvers(config) {
  const result = await timedFetch(config.oracleUrl, config.timeoutMs);
  const status = statusFromLatency(result, config.latencyDegradedMs);

  return component(COMPONENT_IDS.ORACLE_RESOLVERS, 'Optimistic Oracle Resolvers', status, {
    latencyMs: result.latencyMs,
    metrics: {
      statusCode: result.statusCode,
      pendingResolutions:
        result.body && typeof result.body.pendingResolutions === 'number'
          ? result.body.pendingResolutions
          : null,
    },
  });
}

async function probeRestApi(config) {
  const result = await timedFetch(config.apiUrl, config.timeoutMs);
  const status = statusFromLatency(result, config.latencyDegradedMs);

  return component(COMPONENT_IDS.REST_API, 'Backend REST API', status, {
    latencyMs: result.latencyMs,
    metrics: { statusCode: result.statusCode },
  });
}

function overallStatus(components) {
  return components.reduce((worst, item) => {
    return STATUS_RANK[item.status] > STATUS_RANK[worst] ? item.status : worst;
  }, STATUS.OPERATIONAL);
}

/**
 * Run every component probe and return a status-page payload.
 */
async function collectStatus(env) {
  const config = resolveConfig(env);
  const components = await Promise.all([
    probeHorizonRpc(config),
    probeIndexer(config),
    probeOracleResolvers(config),
    probeRestApi(config),
  ]);

  return {
    status: overallStatus(components),
    updatedAt: nowIso(),
    components,
  };
}

module.exports = {
  COMPONENT_IDS,
  STATUS,
  collectStatus,
  probeHorizonRpc,
  probeIndexer,
  probeOracleResolvers,
  probeRestApi,
};

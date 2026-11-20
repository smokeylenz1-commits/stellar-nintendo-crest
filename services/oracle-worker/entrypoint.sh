#!/bin/sh
# Oracle worker entrypoint.
# Runs the oracle resolution/monitoring daemon as a standalone process,
# independent of any web server HTTP lifecycle.
set -eu

# --- Environment configuration (with sane defaults) -------------------------
: "${ORACLE_WORKER_MODE:=daemon}"
: "${ORACLE_POLL_INTERVAL_MS:=15000}"
: "${ORACLE_HEALTHCHECK_PORT:=8081}"
: "${ORACLE_LOG_LEVEL:=info}"
: "${ORACLE_WORKER_ENTRY:=dist/oracle/worker.js}"

export ORACLE_WORKER_MODE ORACLE_POLL_INTERVAL_MS ORACLE_HEALTHCHECK_PORT ORACLE_LOG_LEVEL

log() {
  printf '%s [oracle-worker] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

# --- Graceful shutdown ------------------------------------------------------
WORKER_PID=""

shutdown() {
  log "received termination signal, stopping worker (pid=${WORKER_PID:-none})"
  if [ -n "$WORKER_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null; then
    kill -TERM "$WORKER_PID" 2>/dev/null || true
    # Give the worker a bounded window to drain in-flight resolutions.
    i=0
    while kill -0 "$WORKER_PID" 2>/dev/null && [ "$i" -lt 30 ]; do
      i=$((i + 1))
      sleep 1
    done
    if kill -0 "$WORKER_PID" 2>/dev/null; then
      log "worker did not exit in time, forcing kill"
      kill -KILL "$WORKER_PID" 2>/dev/null || true
    fi
  fi
  exit 0
}

trap shutdown INT TERM

# --- Preflight --------------------------------------------------------------
if [ ! -f "$ORACLE_WORKER_ENTRY" ]; then
  log "worker entrypoint not found: $ORACLE_WORKER_ENTRY"
  exit 1
fi

log "starting oracle worker (mode=$ORACLE_WORKER_MODE, poll=${ORACLE_POLL_INTERVAL_MS}ms, health=:$ORACLE_HEALTHCHECK_PORT)"

# --- Run worker in background so signals are handled here -------------------
node "$ORACLE_WORKER_ENTRY" &
WORKER_PID=$!

# Wait for the worker; propagate its exit code to the container runtime so
# restart policies (on-failure / unless-stopped) behave correctly.
wait "$WORKER_PID"
STATUS=$?
log "oracle worker exited with status $STATUS"
exit "$STATUS"

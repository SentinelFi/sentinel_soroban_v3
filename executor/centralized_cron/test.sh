#!/usr/bin/env bash
# Local test gate for the centralized cron executor.
#  - Boots the mock-api server on a free port
#  - Runs test_run_log.ts (no network)
#  - Runs test_aeroapi.ts against the booted mock-api
#  - Tears down the mock-api
#
# No deployed contracts required. Live-network tests live in test_pipeline.sh
# and are gated by env vars (see plan: deferred to the deploy phase).
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOCK_API_DIR="$SCRIPT_DIR/../mock-api"
PORT=3099

if [ ! -d "$MOCK_API_DIR" ]; then
  echo "[test.sh] Missing mock-api at $MOCK_API_DIR"
  exit 1
fi

# Kill any leftover server on this port
if command -v lsof &>/dev/null; then
    lsof -ti:$PORT | xargs kill 2>/dev/null || true
elif command -v fuser &>/dev/null; then
    fuser -k ${PORT}/tcp 2>/dev/null || true
else
    powershell -Command "Get-NetTCPConnection -LocalPort $PORT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id \$_ -Force -ErrorAction SilentlyContinue }" 2>/dev/null || true
fi
sleep 1

# Start mock-api in background
(cd "$MOCK_API_DIR" && PORT=$PORT npx tsx src/server.ts) >/dev/null 2>&1 &
MOCK_PID=$!
cleanup() { kill $MOCK_PID 2>/dev/null || true; }
trap cleanup EXIT
sleep 2

echo "─────────────────────────────────────"
echo "1/2  test_run_log.ts (no network)"
echo "─────────────────────────────────────"
npx tsx "$SCRIPT_DIR/src/test_run_log.ts"

echo ""
echo "─────────────────────────────────────"
echo "2/2  test_aeroapi.ts (mock-api on :$PORT)"
echo "─────────────────────────────────────"
AEROAPI_BASE_URL="http://localhost:$PORT" npx tsx "$SCRIPT_DIR/src/test_aeroapi.ts"

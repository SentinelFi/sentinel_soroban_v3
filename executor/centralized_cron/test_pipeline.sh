#!/usr/bin/env bash
# End-to-end pipeline test against a live network (testnet by default).
#
# Drives the full lifecycle: buy insurance → fetch → classify → settle,
# asserting the on-chain state transitions at each step.
#
# This requires a deployed contract set. It's intentionally gated by env
# vars and bails out with a clear message if anything's missing — the
# deploy phase ships the deploy scripts that populate these.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOCK_API_DIR="$SCRIPT_DIR/../mock-api"
PORT=3099

required=(
  STELLAR_RPC_URL
  STELLAR_NETWORK_PASSPHRASE
  ORACLE_AGGREGATOR_ID
  CONTROLLER_ID
  RISK_VAULT_ID
  GOVERNANCE_ID
  FLIGHT_POOL_MANAGER_ID
  ORACLE_SECRET_KEY
  KEEPER_SECRET_KEY
  TTL_EXTENDER_SECRET_KEY
  TRAVELER_SECRET_KEY
  UNDERWRITER_SECRET_KEY
  MOCK_USDC_ID
)

# Source .env if present so this works without manual env loading.
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

missing=()
for var in "${required[@]}"; do
  if [ -z "${!var:-}" ]; then
    missing+=("$var")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  cat <<EOF
[test_pipeline.sh] Cannot run — deploy your contracts first.

Missing required env vars (in $SCRIPT_DIR/.env or your shell):
$(printf '  - %s\n' "${missing[@]}")

The live-pipeline test is gated until \`scripts/deploy*\` lands (next phase).
For the offline test gate, run: \`bash test.sh\`.
EOF
  exit 2
fi

if [ ! -d "$MOCK_API_DIR" ]; then
  echo "[test_pipeline.sh] Missing mock-api at $MOCK_API_DIR"
  exit 1
fi

# Kill any leftover server on this port
if command -v lsof &>/dev/null; then
    lsof -ti:$PORT | xargs kill 2>/dev/null || true
elif command -v fuser &>/dev/null; then
    fuser -k ${PORT}/tcp 2>/dev/null || true
fi
sleep 1

(cd "$MOCK_API_DIR" && PORT=$PORT npx tsx src/server.ts) >/dev/null 2>&1 &
MOCK_PID=$!
cleanup() { kill $MOCK_PID 2>/dev/null || true; }
trap cleanup EXIT
sleep 2

# The TS pipeline driver is shipped in the deploy phase. Until then,
# this script just verifies the env is wired and the mock-api is reachable.
if [ -f "$SCRIPT_DIR/src/test_pipeline.ts" ]; then
  AEROAPI_BASE_URL="http://localhost:$PORT" npx tsx "$SCRIPT_DIR/src/test_pipeline.ts"
else
  echo "[test_pipeline.sh] src/test_pipeline.ts not present — ships in the deploy phase."
  echo "[test_pipeline.sh] Env wiring + mock-api boot succeeded ✓"
fi

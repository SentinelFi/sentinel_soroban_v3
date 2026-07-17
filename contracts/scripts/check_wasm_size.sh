#!/usr/bin/env bash
# Verify every contract Wasm fits Soroban's per-contract size cap.
#
# The network enforces a hard maximum on uploaded contract code
# (`maxContractSizeBytes`, 64 KiB). A contract that compiles past it fails at
# UPLOAD time — long after the code merged — so this check runs in CI against
# the same unoptimized artifacts `make deploy-testnet` ships, turning a
# deploy-day surprise into a red pull request. Validators can vote to change
# the network setting; re-verify HARD_LIMIT against the live network
# configuration before relying on a raise.
#
# Run from anywhere; artifacts must exist first (`stellar contract build`).
set -euo pipefail

cd "$(dirname "$0")/.."

WASM_DIR="target/wasm32v1-none/release"
CONTRACTS=(controller risk_vault flight_pool_manager oracle_aggregator governance_module mock_usdc)

# Soroban network cap on contract code size, in bytes (64 KiB).
HARD_LIMIT=65536
# Early-warning threshold: flag anything within 10% of the cap so growth is
# visible in CI output well before it becomes a failed upload.
WARN_PCT=90

fail=0
rows=""
printf '%-22s %8s %7s  %s\n' "contract" "bytes" "of cap" "status"
for c in "${CONTRACTS[@]}"; do
  f="$WASM_DIR/$c.wasm"
  if [[ ! -f "$f" ]]; then
    echo "error: $f not found — run 'stellar contract build' first" >&2
    exit 1
  fi
  size=$(wc -c < "$f" | tr -d '[:space:]')
  pct=$((size * 100 / HARD_LIMIT))
  status="ok"
  if ((size > HARD_LIMIT)); then
    status="FAIL: exceeds the ${HARD_LIMIT}-byte network cap"
    fail=1
  elif ((pct >= WARN_PCT)); then
    status="warning: within 10% of the network cap"
  fi
  printf '%-22s %8d %6d%%  %s\n' "$c" "$size" "$pct" "$status"
  rows="${rows}| \`$c\` | $size | ${pct}% | $status |"$'\n'
done

# Mirror the table into the GitHub Actions job summary when available.
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Contract Wasm sizes (network cap: ${HARD_LIMIT} bytes)"
    echo ""
    echo "| contract | bytes | of cap | status |"
    echo "| --- | ---: | ---: | --- |"
    printf '%s' "$rows"
  } >>"$GITHUB_STEP_SUMMARY"
fi

if ((fail)); then
  echo "" >&2
  echo "error: at least one contract exceeds the network's contract-size cap — its upload/deploy would fail" >&2
  exit 1
fi

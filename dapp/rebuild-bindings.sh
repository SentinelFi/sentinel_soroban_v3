#!/usr/bin/env bash
# Rebuild contract WASM + regenerate TypeScript bindings for the dapp.
# Run from dapp/ after modifying contracts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."
CONTRACTS_DIR="$PROJECT_ROOT/contracts"

echo "=== Building contracts ==="
cd "$CONTRACTS_DIR"
stellar contract build
echo ""

echo "=== Generating TypeScript bindings ==="
# Generate straight from the built wasm — `stellar scaffold build
# --build-clients` silently produces nothing here (no environments.toml).
cd "$SCRIPT_DIR"
for name in controller flight_pool_manager governance_module mock_usdc oracle_aggregator risk_vault; do
  stellar contract bindings typescript \
    --wasm "$CONTRACTS_DIR/target/wasm32v1-none/release/$name.wasm" \
    --output-dir "$SCRIPT_DIR/packages/$name" \
    --overwrite
done

echo ""
echo "=== Installing generated packages ==="
npm run install:contracts

echo ""
echo "Done. Contract bindings in packages/ are up to date."

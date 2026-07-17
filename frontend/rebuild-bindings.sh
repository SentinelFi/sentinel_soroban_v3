#!/usr/bin/env bash
# Rebuild contract WASM + regenerate TypeScript bindings for the frontend.
# Run from frontend/ after modifying contracts.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."
CONTRACTS_DIR="$PROJECT_ROOT/contracts"

echo "=== Building contracts ==="
cd "$CONTRACTS_DIR"
stellar contract build
echo ""

echo "=== Generating TypeScript bindings ==="
cd "$SCRIPT_DIR"
STELLAR_SCAFFOLD_ENV=development stellar scaffold build --build-clients --manifest-path "$CONTRACTS_DIR/Cargo.toml"

echo ""
echo "=== Installing generated packages ==="
npm run install:contracts

echo ""
echo "Done. Contract bindings in packages/ are up to date."

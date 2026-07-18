#!/usr/bin/env bash
# Rebuild contract WASM + regenerate TypeScript bindings for the dapp.
# Run from dapp/ after modifying contracts.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."
CONTRACTS_DIR="$PROJECT_ROOT/contracts"

echo "=== DEBUG ==="
echo "SCRIPT_DIR: $SCRIPT_DIR"
echo "PROJECT_ROOT: $PROJECT_ROOT"
echo "CONTRACTS_DIR: $CONTRACTS_DIR"
echo "--- contents of PROJECT_ROOT ---"
ls -la "$PROJECT_ROOT"
echo "=== END DEBUG ==="

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

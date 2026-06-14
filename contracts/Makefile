# Makefile for the Sentinel Soroban contracts.
# Run all targets from inside the `contracts` folder.

# Deploy/optimize read artifacts from here.
TARGET    := wasm32v1-none
WASM_DIR  := target/$(TARGET)/release
CONTRACTS := mock_usdc flight_pool_manager risk_vault oracle_aggregator governance_module controller

# Network/identity used by deploy-testnet and bindings.
NETWORK   := testnet
SOURCE    := alice

.DEFAULT_GOAL := help

.PHONY: help test build optimize deploy-testnet clippy format format-check \
        audit clean scout-install scout-run bindings keys check ci all

help: ## Show help
	@echo "Available:"
	@echo ""
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | \
		sort | \
		awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

test: ## Run the full test suite
	cargo test

build: ## Build all contracts to wasm
	cargo build
	stellar contract build

optimize: ## Build and optimize the contract wasm artifacts
	stellar contract build --optimize

deploy-testnet: build ## Deploy all contracts to testnet (override SOURCE/NETWORK as needed)
	stellar contract deploy --wasm $(WASM_DIR)/mock_usdc.wasm --source-account $(SOURCE) --network $(NETWORK) --alias mock_usdc -- --admin $(SOURCE)
	stellar contract deploy --wasm $(WASM_DIR)/flight_pool_manager.wasm --source-account $(SOURCE) --network $(NETWORK) --alias flight_pool_manager -- --owner $(SOURCE) --asset_token $(SOURCE) --risk_vault $(SOURCE)
	stellar contract deploy --wasm $(WASM_DIR)/risk_vault.wasm --source-account $(SOURCE) --network $(NETWORK) --alias risk_vault -- --owner $(SOURCE) --asset_token $(SOURCE)
	stellar contract deploy --wasm $(WASM_DIR)/oracle_aggregator.wasm --source-account $(SOURCE) --network $(NETWORK) --alias oracle_aggregator -- --owner $(SOURCE) --authorized_oracle $(SOURCE)
	stellar contract deploy --wasm $(WASM_DIR)/governance_module.wasm --source-account $(SOURCE) --network $(NETWORK) --alias governance_module -- --owner $(SOURCE) --default_premium 100 --default_payoff 200 --default_delay_hours 3
	stellar contract deploy --wasm $(WASM_DIR)/controller.wasm --source-account $(SOURCE) --network $(NETWORK) --alias controller -- --owner $(SOURCE) --governance $(SOURCE) --risk_vault $(SOURCE) --oracle $(SOURCE) --flight_pool_manager $(SOURCE) --asset_token $(SOURCE) --authorized_keeper $(SOURCE) --min_lead_time 3600 --claim_expiry_window 86500

clippy: ## Lint with clippy, treating warnings as errors
	cargo clippy --all-targets -- -D warnings

format: ## Format all code with rustfmt
	cargo fmt --all

format-check: ## Check formatting without writing changes
	cargo fmt --all --check

audit: ## Audit dependencies for known vulnerabilities
	cargo audit

scout-install: ## Install the cargo-scout-audit static analyzer
	cargo install cargo-scout-audit --locked

scout-run: ## Run the Soroban scout static analysis
	cargo scout-audit

bindings: build ## Generate TypeScript bindings for all contracts into ../bindings
	@for c in $(CONTRACTS); do \
		stellar contract bindings typescript --network $(NETWORK) --wasm $(WASM_DIR)/$$c.wasm --output-dir ../bindings/$$c --overwrite; \
	done

keys: ## Generate and fund the test identity ($(SOURCE)) on $(NETWORK)
	stellar keys generate $(SOURCE) --network $(NETWORK) --fund
	stellar keys address $(SOURCE)

check: format-check clippy test ## Run formatting, lint, test checks

ci: check audit ## Run the full local CI (check + audit)

all: format clippy test build ## Format, lint, test, build

clean: ## Remove build artifacts
	cargo clean

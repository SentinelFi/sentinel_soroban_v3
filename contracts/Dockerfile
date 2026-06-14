# Contract development environment for the Sentinel Soroban contracts.
#
# Build from inside the `contracts/` directory (that is the build context):
#   docker build -t sentinel-contracts .
#
# The image pins the Rust toolchain to match rust-toolchain.toml, installs the
# Stellar CLI and the wasm32v1-none target, then builds, optimizes, and tests
# the workspace as part of the image build.
#
# Versions can be overridden at build time, e.g.:
#   docker build --build-arg STELLAR_CLI_VERSION=26.0.0 -t sentinel-contracts .

# Rust toolchain version — keep in sync with rust-toolchain.toml (channel).
ARG RUST_VERSION=1.94.0
FROM rust:${RUST_VERSION}-bookworm

# Pinned tool versions / target (override with --build-arg as needed).
ARG STELLAR_CLI_VERSION=26.0.0
ARG WASM_TARGET=wasm32v1-none

# --- System dependencies -------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# --- Rust toolchain ------------------------------------------------------
# The base image already provides cargo/rustc at ${RUST_VERSION} (cargo tracks
# the same version). Add the wasm target and the components declared in
# rust-toolchain.toml so they are baked into a cached layer.
RUN rustup target add "${WASM_TARGET}" \
    && rustup component add rustfmt clippy llvm-tools-preview

# --- Stellar CLI ---------------------------------------------------------
# Install the prebuilt release binary (avoids a long from-source compile and
# its system-dependency footprint).
RUN curl -sSL \
    "https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/stellar-cli-${STELLAR_CLI_VERSION}-x86_64-unknown-linux-gnu.tar.gz" \
    -o /tmp/stellar-cli.tar.gz \
    && tar -xzf /tmp/stellar-cli.tar.gz -C /usr/local/bin stellar \
    && rm /tmp/stellar-cli.tar.gz \
    && chmod +x /usr/local/bin/stellar \
    && stellar --version

WORKDIR /workspace

# Copy the whole contracts workspace into the image. A .dockerignore keeps the
# local target/ and other build artifacts out of the build context.
COPY . .

# Sanity check: the image toolchain must match rust-toolchain.toml.
RUN rustc --version && cargo --version

# --- Build, optimize, test ----------------------------------------------
RUN stellar contract build --optimize
RUN cargo test

# Drop into a shell by default for interactive development.
CMD ["bash"]

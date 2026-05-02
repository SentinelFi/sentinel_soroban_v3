---
description: Scaffold Stellar reference for frontend dApp development. Trigger when initializing the frontend project, running scaffold CLI commands, configuring environments.toml, generating TypeScript contract bindings, deploying via the registry, or connecting React UI to Soroban contracts.
---

# Skill: Scaffold Stellar

## Layer 1 — Quick Reference (always read this)

**What it is:** CLI toolkit that scaffolds a React + Vite frontend with auto-generated TypeScript clients for Soroban contracts.

### Install

```bash
cargo install --locked stellar-scaffold-cli
cargo install --locked stellar-registry-cli
```

### The 4 commands you'll use most

| Command | What it does |
|---|---|
| `stellar scaffold init <path>` | Create new project with sample contracts + React frontend |
| `stellar scaffold upgrade` | Convert existing Soroban workspace into scaffold project |
| `stellar scaffold build` | Compile contracts → WASM, generate TS clients in `packages/` |
| `stellar scaffold watch` | Dev mode with hot reload (contracts + bindings) |

### Project layout

```
my-project/
├── contracts/          # Rust Soroban contracts
├── packages/           # Auto-generated TypeScript clients (one per contract)
├── src/                # React + Vite frontend
├── environments.toml   # Network config per environment
├── .env                # Local env vars (STELLAR_SCAFFOLD_ENV, etc.)
└── package.json        # Frontend deps
```

### Using generated clients

```typescript
import { ControllerClient } from '../packages/controller';

const tx = await controllerClient.buy_insurance({
  flight_id: 'AA123',
  origin: 'DEN',
  dest: 'SEA',
  date: 1710000000n,
});
await tx.signAndSend();
```

### Environment switching

Set `STELLAR_SCAFFOLD_ENV=development|staging|production` in `.env`.

### Minimal environments.toml

```toml
[development]
network = { name = "testnet" }
accounts = ["alice"]

[development.contracts.controller]
client = true

[production]
network = { name = "mainnet" }

[production.contracts.controller]
id = "CABC..."
client = true
```

---

## Layer 2 — environments.toml full config

> Only read this when configuring environments.toml, setting up constructor args, or writing after_deploy scripts.

### Network options

```toml
[development]
network = { name = "testnet" }                    # testnet, mainnet, or local
# OR custom:
network = { name = "custom", rpc_url = "https://...", network_passphrase = "..." }
# Local docker node:
network = { name = "local", run_locally = true }
```

### Account aliases

```toml
accounts = ["deployer", "admin"]
# OR with defaults:
accounts = [{ name = "admin", default = true }, "user1"]
```

### Contract config

```toml
[development.contracts.my_contract]
client = true                              # generate TS client (default: true)
constructor_args = "--arg1 value1"          # passed to deploy
after_deploy = """
STELLAR_ACCOUNT=admin set_config --param value
"""
```

- `constructor_args` supports `STELLAR_ACCOUNT=<alias>` and `$(command)` substitution
- `after_deploy` runs post-deployment setup (development only)
- `id = "CABC..."` pins a fixed contract ID (production/staging)

---

## Layer 3 — CLI commands full reference

> Only read this when you need flags for build, generate, or update-env commands.

### stellar scaffold init

```bash
stellar scaffold init <project-path> [name]
```

### stellar scaffold build

```bash
stellar scaffold build [options]
  --build-clients       # Also generate TS client packages
  --list / --ls         # List package names in build order
```

### stellar scaffold watch

```bash
stellar scaffold watch [options]
  --build-clients       # Regenerate TS clients on change
```

### stellar scaffold generate contract

```bash
stellar scaffold generate contract [options]
  --from <example>       # Clone from OpenZeppelin examples
  --ls                   # List available examples
  --from-wizard          # Open OZ contract wizard in browser
  -o <dir>               # Output directory (default: contracts/<name>)
```

### stellar scaffold upgrade

```bash
stellar scaffold upgrade [workspace-path]   # defaults to current dir
```

### stellar scaffold update-env

```bash
stellar scaffold update-env --name <VAR> [--value <VAL>] [--env-file <PATH>]
```

---

## Layer 4 — Registry (publish, deploy, install)

> Only read this when deploying contracts to testnet/mainnet via the registry, or managing contract versions.

### Publish

```bash
stellar registry publish --wasm <PATH> [--wasm-name <NAME>] [--binver <VERSION>] [--author <ADDR>] [--dry-run]
```

- Names normalize to lowercase, underscores → hyphens
- Must start with alpha, max 64 chars
- Prefix `unverified/` for open publishing (no manager approval)

### Deploy

```bash
# Named deployment
stellar registry deploy --contract-name <INSTANCE_NAME> --wasm-name <PUBLISHED_NAME> [--version <VER>] [--deployer <ADDR>] -- [CONSTRUCTOR_ARGS...]

# Unnamed deployment
stellar registry deploy-unnamed --wasm-name <NAME> [--version <VER>] [--salt <HEX>] [--deployer <ADDR>] -- [ARGS...]
```

### Install locally

```bash
stellar registry create-alias <CONTRACT_NAME>
# Then use with stellar-cli:
stellar contract invoke --id <contract-name> -- --help
```

### Query commands

```bash
stellar registry fetch-contract-id <NAME>       # Get deployed contract ID
stellar registry fetch-hash <WASM_NAME> [--version <VER>]  # Get WASM hash
stellar registry current-version <WASM_NAME>     # Latest version number
```

### Register existing contract

```bash
stellar registry register-contract --contract-name <NAME> --contract-address <ADDR> [--owner <ADDR>]
```

### Registry addresses

| Network | Contract ID |
|---|---|
| Testnet | `CBFFTTX7QKA76FS4LHHQG54BC7JF5RMEX4RTNNJ5KEL76LYHVO3E3OEE` |
| Mainnet | `CCRKU6NT4CRG4TVKLCCJFU7EOSAUBHWGBJF2JWZJSKTJTXCXXTKOJIUS` |

### Config env vars

```
STELLAR_REGISTRY_CONTRACT_ID
STELLAR_NETWORK          # testnet / mainnet
STELLAR_RPC_URL
STELLAR_NETWORK_PASSPHRASE
STELLAR_ACCOUNT
```

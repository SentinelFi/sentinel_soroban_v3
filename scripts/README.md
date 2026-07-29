# Ops scripts

Operational scripts for the live testnet deployment (seeding, soak tests,
actor management). These import the dapp's libraries, so run them **from
`dapp/`** with its toolchain:

```sh
cd dapp && npx tsx ../scripts/<script>.ts [flags]
```

| Script | Purpose |
|---|---|
| `seed_routes.ts` | Idempotently whitelist every enabled route from `dapp/config/routes.testnet.json` on-chain (the 200 AeroAPI-discovered routes + hand-seeded ones). `--dry-run` previews without transactions. |

Signing: scripts that write governance state use `GOVERNANCE_ADMIN_SECRET_KEY`
from the environment, falling back to the local `sentinel-governor` stellar
identity (`stellar keys show sentinel-governor`).

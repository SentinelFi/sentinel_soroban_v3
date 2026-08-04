# Before mainnet — accumulated fix list

Everything known to need fixing, deciding, or upgrading before the tenure-gated
mainnet launch (see `spec/TODO.md` launch plan). Grouped by the kind of work;
items marked **[contract]** belong to one coherent contract-upgrade + re-audit
bundle so the chain is touched once.

## Contract upgrade bundle (one upgrade, re-audit together)

- [ ] **[contract] Insure both legs of out-and-back flight numbers.** The whole
  settlement path is keyed by `(flight_id, date)`: GovernanceModule maps each
  flight ID to exactly ONE route (`FlightIdAlreadyMapped` #505), and the oracle
  stores one outcome per flight per day. Airlines reuse the same number for the
  return leg (e.g. `DAL860` BOS→SFO morning / SFO→BOS evening, same date), so
  ~10% of the priced catalog (121 of 1,190 routes in the 2026-08-04 seed) is
  forfeited to duplicates. Fix is a coherent stack change: composite route key
  `(flight_id, origin, dest)` in GovernanceModule + leg-disambiguated outcome
  storage in OracleAggregator + AeroAPI client ambiguity guard selecting the
  leg by origin/dest (the client already validates legs — tractable).
- [ ] **[contract] Batch `whitelist_routes(vec)` entrypoint.** Seeding is one
  tx per route (Stellar: one tx per source account per ~5s ledger). The
  2026-08-04 testnet seed of ~1,190 routes took ~3h and would cost real XLM on
  mainnet. One tx per ~25–50 routes turns seeding into minutes and cuts fees
  proportionally.
- [ ] **[contract] Swap `mock_usdc` for the real USDC SAC** as the asset token
  (Controller `asset_token`, vault, pool manager). Includes trustline/funding
  strategy for actors and treasury.
- [ ] Re-audit the bundle (5 prior audit rounds are on the current code; the
  upgrade invalidates that coverage for changed modules).

## Off-chain tooling

- [ ] **Deliberate duplicate-leg dedupe in `price_routes.ts`.** Today
  first-occurrence-wins decides which leg of a duplicate flight number gets
  seeded — arbitrary, and in ~a dozen cases it picked the cheaper leg (e.g.
  `AAL2086` seeded BOS→PHL $10, dropped ORD→LGA $20). Rule: keep the
  higher-premium leg, tie-break earlier departure; write losers to an
  `excluded_duplicate_leg` section so the staged file matches what can land
  on-chain and idempotent re-seeds stop re-failing 121 zombie entries.
  (Superseded on-chain by the composite-key fix, but cheap and useful now.)
- [ ] Optional: sharded seeding across 2–3 extra governance admins
  (owner `add_admin`) for faster re-seeds until the batch entrypoint lands.

## Services & costs (commercial posture)

- [ ] **Open-Meteo commercial license** (~€29/mo) — current keyless free tier
  is non-commercial only; mainnet with real premiums is commercial use.
- [ ] **Supabase Pro** (~$25/mo) — daily backups + no free-tier pause risk for
  the governance DB that drives live interventions.
- [ ] AeroAPI plan review at projected policy volume (cost scales ~½–1¢ per
  buy + one call per settle; fine at launch volume, revisit tiers with growth).
- [ ] Render ML service: Starter ($7/mo) is fine; add a real `/healthz` route
  (service 404s there today — probes currently use `/docs`).
- [ ] **Name + domain** (launch blocker per launch plan): waitlist on apex,
  dapp at `app.<domain>`, game separate. Wire custom domain to the
  `sentinel-dapp` Vercel project.

## Keys, funding & ops

- [ ] **Mainnet XLM funding** for oracle / keeper / governor accounts — no
  friendbot on mainnet. Decide float per account + a low-balance alert (crons
  die silently when the signer can't pay fees).
- [ ] **Fresh mainnet keypairs** for all roles (testnet secrets have lived in
  local keychain + Vercel env; mint new ones for mainnet, owner key kept
  offline/local-only as today).
- [ ] State TTL rent is real money on mainnet — sanity-check `ttl` cron
  cadence + per-entry rent cost at 1k+ routes before seeding the full catalog.
- [ ] **Buyer whitelist ON at launch** (tenure-gated mainnet per launch plan;
  testnet runs whitelist-off). Decide the tenure criteria + credits mechanics
  (credits are mainnet-only).
- [ ] Seed a *curated* mainnet route set (small, high-liquidity pairs), not the
  full 1k+ catalog — seeding cost, TTL rent, and exposure all scale with it.

## Verification gates

- [ ] **Live soak test passes** (`spec/soak_test_plan.md`): 24–48h, 25–30
  policies, crons settle autonomously, reconciliation report clean.
- [ ] Docs drift cleanup: `DEPLOYMENT.md` says 8 crons / README says 11 /
  `vercel.json` has 10 — reconcile after the deployment settles; document the
  `.js`-extension requirement for `api/` imports (Vercel ESM, fix `982caba`).
- [ ] Check SDF's announced testnet reset schedule before long-running testnet
  commitments (resets wipe contracts + seeded state).

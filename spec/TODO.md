# TODO — Launch plan: waitlist + app + game (2026-07-31)

Replaces the completed 2026-08-01 frontend-audit list (all items shipped;
history in git).

**Launch shape (decided):** waitlist = landing page at the root domain,
dapp at `app.<domain>`, game stays separate on proofarcade.xyz. Testnet
launches open (whitelist OFF, anyone joins, earns points). Mainnet ships
whitelist ON, fed by a 30-day tenure rule from the waitlist DB; whitelist
turns OFF a few months after mainnet. Free-insurance credits (admin
grants first, then points redemption) arrive on mainnet only.

**Guiding rule:** unify data and identity (one DB, wallet address as the
key), federate the UIs (three separate frontends, shared design
language). Do NOT merge the waitlist/dapp/game codebases.

Repos: **[wl]** = waitlist repo (`../waitlist`) · **[dapp]** = this repo ·
**[game]** = `~/Desktop/indie/flight_scroll`.

Legend: **NOW** = testnet launch · **LATER** = mainnet phase.

---

## 0. Blockers / decisions

- [ ] **NOW — Pick the front-door name + domain.** Three brands in play
  (Sentinel / FLIGHTS.FUN / ProofArcade). Decision: Sentinel = protocol +
  root domain, ProofArcade stays its own arcade brand; decide whether the
  dapp is "the Sentinel app" or keeps FLIGHTS.FUN as a product name.
  Blocks hero copy, domain purchase, and Mailjet sender domain.

## 1. Database unification

- [ ] **NOW [wl] — Merge waitlist Postgres into the dapp's Supabase
  project.** Waitlist tables in their own schema; keep Drizzle; waitlist
  API just gets the new `DATABASE_URL`. One project, one dashboard.
- [ ] **NOW [wl] — Wallet address (G-address) as the canonical shared
  identity key** across waitlist and dapp tables (already true informally
  in both — make it official).
- [ ] **NOW [wl] — `points_ledger` table.** One row per points event:
  source (`game` / `email` / `referral` / `activity`), amount, timestamp.
  Existing `game_points` / `signup_points` columns become derived totals.
  Provenance matters: testnet points are future claims on real treasury
  money — never collapse into one opaque total.
- [ ] **NOW [wl] — Tenure fields on `waitlist_entry`:**
  `first_activity_at`, `eligible_at` (signup + 30 days).
- [ ] **LATER [wl] — `credits` table** (recipient, premium cap, expiry,
  status, granted_by + reason OR points_burned) + `comp_budget` running
  counter with a hard ceiling. One mechanism, two entry points: admin
  grant and points redemption both mint the same credit record.

## 2. Automation (crons + email)

- [ ] **NOW [wl] — Game-points sync cron.** Set `SENTINEL_CONTRACT_ID` to
  the game_hub contract
  (`CCEXYEIJK3JSN35F3CFE4Y7SAPUNIFHDMSKBBAWLKL2GSMRTYFUJCGYN`, testnet);
  verify the existing cron's read path matches game_hub's actual
  interface (`get_players_page` / `get_score`); write into the points
  ledger. Scores are capped at 600, personal-best only — safe to sync.
- [ ] **NOW [wl] — Wire Mailjet.** Sender-domain setup, verification
  email (points awarded ONLY on verify, not on entry), templates for
  "boarding pass ready" and the future mainnet invite. Launch-critical
  now: email is both a points source and the invitation channel.
- [ ] **NOW [wl] — Tenure cron (daily).** Flip
  `whitelisted = true, reason = "tenure"` when: 30 days elapsed AND email
  verified AND engagement bar met (nonzero game points OR ≥1 settled
  testnet policy). The engagement bar is the sybil defense — pure clock
  time is trivially farmable across wallets.
- [ ] **NOW [dapp] — Activity-points hook.** First settled testnet policy
  per wallet → one-time bonus row in the points ledger. Time/one-shot
  based, NOT per-policy volume — testnet activity is free, volume-based
  points would be farmable.
- [ ] **LATER [dapp] — Allowlist sync cron.** Daily batch push of newly
  whitelisted wallets → Controller allowlist via the existing gov
  pipeline (batched — mainnet writes cost real fees).

## 3. Waitlist UI (boarding-pass framing)

- [ ] **NOW [wl] — Hero rework.** Connect wallet + email; CTA "Get your
  boarding pass." One promise, one CTA.
- [ ] **NOW [wl] — Three quest cards** with point values: Play Birdstrike
  (→ proofarcade.xyz), Fly the testnet (→ app), Invite friends (existing
  /invite).
- [ ] **NOW [wl] — Connected state = boarding pass panel.** Points
  balance, leaderboard rank, 30-day countdown to mainnet eligibility,
  "BOARDING" badge when whitelisted. The countdown is the retention hook.
- [ ] **NOW [wl] — Points page shows ledger breakdown by source**, not
  just a total.
- [ ] **NOW [wl] — Timeline strip:** "Testnet open now → Mainnet boarding
  (gated) → Open to all." Whitelist copy sells urgency, points copy sells
  the durable loop.
- [ ] **LATER [wl] — Admin panel: grant-credit form + comp-budget view**
  (manual whitelist add already exists). Every grant logged with granter,
  recipient, reason, timestamp.

## 4. Cross-property glue (federated UIs, one product feel)

- [ ] **NOW [wl+dapp] — Shared design tokens + header.** Align palette /
  pixel fonts; shared header (logo + Points | Play | App) across waitlist
  and dapp. A tokens file + copied component, NOT a monorepo merge.
- [ ] **NOW [wl] — Points-by-wallet endpoint** so the dapp can display
  points / boarding status for the connected wallet. (Alternative:
  session cookie scoped to `.rootdomain` — endpoint is simpler.)
- [ ] **NOW [game] — Make the "Earn points for Sentinel Protocol" banner
  real:** link it to the waitlist landing page. Nothing else — scores
  already flow via the contract.

## 5. Dapp

- [ ] **NOW [dapp] — Expose the "policy settled for wallet X" signal**
  the activity-points hook needs (feeds §2).
- [ ] **LATER [dapp] — Sale-auth honors credits.** JIT sale-auth checks
  the `credits` table at buy-click; valid credit → treasury wallet pays
  the premium. Off-chain only — no contract changes. Exercise end-to-end
  on testnet (free) before it spends real money.
- [ ] **LATER [dapp] — Mainnet flip:** deploy contracts, whitelist ON,
  seed Controller allowlist from waitlist DB. Redemption caps: per-wallet
  (likely 1 free policy) + global comp budget = launch marketing budget.

## 6. Infra / deploy

- [ ] **NOW [wl] — Deploy waitlist web (Vercel, already linked) + API.**
  Decide Railway vs consolidating onto Vercel Pro next to the dapp
  backend — lean consolidate (one platform; unified DB removes the main
  reason to keep them apart).
- [ ] **NOW — Domains:** root = waitlist landing, `app.<domain>` = dapp.
  Blocked on §0 name decision.
- [ ] **LATER — Whitelist OFF flip** (a few months post-mainnet) — config
  change only.

---

**Critical path (NOW):** name/domain → DB merge → Mailjet → game-points
cron → landing UI → deploy. Everything LATER is ignorable until mainnet
planning starts.

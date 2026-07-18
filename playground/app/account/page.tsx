"use client";

// My Account — everything scoped to the connected wallet: balances and
// faucets, buying insurance, claiming payouts, and the vault position.

import { useState } from "react";
import {
  FaArrowRotateRight,
  FaCoins,
  FaDroplet,
  FaFileContract,
  FaPlaneDeparture,
  FaVault,
  FaWallet,
} from "react-icons/fa6";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { useWallet } from "@/app/providers";
import { CONTRACTS, explorerTxUrl } from "@/lib/config";
import {
  dateStringToUnixDay,
  formatAmount,
  formatTimestamp,
  parseAmount,
  unixToDateString,
} from "@/lib/format";
import {
  fetchMyPolicies,
  fetchRouteStatus,
  fetchUsdcBalance,
  fetchVaultPosition,
} from "@/lib/queries";
import {
  fetchXlmBalance,
  fundWithFriendbot,
  invokeWrite,
  simulateRead,
} from "@/lib/soroban";
import { useAsync } from "@/lib/useAsync";

const addr = (a: string) => Address.fromString(a).toScVal();
const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const u64v = (n: bigint) => nativeToScVal(n, { type: "u64" });
const i128v = (n: bigint) => nativeToScVal(n, { type: "i128" });

type ActionStatus =
  | { kind: "idle" }
  | { kind: "pending"; text: string }
  | { kind: "ok"; text: string; txHash?: string }
  | { kind: "error"; text: string };

function StatusBox({ status }: { status: ActionStatus }) {
  if (status.kind === "idle") return null;
  return (
    <div
      className={`result-box ${status.kind === "error" ? "error" : status.kind === "pending" ? "pending" : ""}`}
    >
      {status.text}
      {status.kind === "ok" && status.txHash && (
        <>
          {"\n"}
          <a href={explorerTxUrl(status.txHash)} target="_blank" rel="noopener noreferrer">
            View transaction on stellar.expert →
          </a>
        </>
      )}
    </div>
  );
}

/** Shared "run a write" helper: keeps per-card status + busy flag. */
function useAction() {
  const { address, signXdr } = useWallet();
  const [status, setStatus] = useState<ActionStatus>({ kind: "idle" });
  const [busy, setBusy] = useState(false);

  const run = async (
    contract: string,
    method: string,
    args: xdr.ScVal[],
    okText: string,
    after?: () => void,
  ) => {
    if (!address) return;
    setBusy(true);
    setStatus({ kind: "pending", text: "Simulating, then requesting a signature in your wallet…" });
    try {
      const { hash } = await invokeWrite(address, contract, method, args, signXdr);
      setStatus({ kind: "ok", text: okText, txHash: hash });
      after?.();
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return { address, status, setStatus, busy, setBusy, run };
}

function BalancesCard() {
  const { address } = useWallet();
  const action = useAction();
  const xlm = useAsync(
    async () => (address ? fetchXlmBalance(address) : null),
    [address],
  );
  const usdc = useAsync(
    async () => (address ? fetchUsdcBalance(address) : null),
    [address],
  );

  const reload = () => {
    xlm.reload();
    usdc.reload();
  };

  if (!address) return null;

  return (
    <section className="panel">
      <h2 className="panel-title">
        <FaCoins size={16} /> Balances &amp; Faucets
        <button className="icon-btn" onClick={reload} aria-label="Reload" style={{ marginLeft: "auto" }}>
          <FaArrowRotateRight size={13} />
        </button>
      </h2>
      <div className="grid-3">
        <div className="stat">
          <div className="k">XLM</div>
          <div className="v">
            {xlm.loading ? "…" : xlm.data === null ? "not funded" : xlm.data}
          </div>
          <div className="hint">pays transaction fees</div>
        </div>
        <div className="stat">
          <div className="k">USDC (mock)</div>
          <div className="v">{usdc.loading || usdc.data === null ? "…" : formatAmount(usdc.data, 7)}</div>
          <div className="hint">premiums &amp; vault deposits</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, justifyContent: "center" }}>
          {xlm.data === null && !xlm.loading && (
            <button
              className="btn btn-sm"
              disabled={action.busy}
              onClick={() => {
                action.setBusy(true);
                action.setStatus({ kind: "pending", text: "Requesting XLM from Friendbot…" });
                fundWithFriendbot(address)
                  .then(() => {
                    action.setStatus({ kind: "ok", text: "Account funded with testnet XLM." });
                    reload();
                  })
                  .catch((e: unknown) =>
                    action.setStatus({ kind: "error", text: e instanceof Error ? e.message : String(e) }),
                  )
                  .finally(() => action.setBusy(false));
              }}
            >
              <FaDroplet size={12} /> Fund with Friendbot (XLM)
            </button>
          )}
          <button
            className="btn btn-sm"
            disabled={action.busy || xlm.data === null}
            title={xlm.data === null ? "Fund the account with XLM first" : undefined}
            onClick={() =>
              void action.run(
                CONTRACTS.mock_usdc.address,
                "faucet",
                [addr(address)],
                "Minted 10,000 test USDC to your account.",
                reload,
              )
            }
          >
            <FaDroplet size={12} /> USDC faucet (+10,000)
          </button>
        </div>
      </div>
      <StatusBox status={action.status} />
    </section>
  );
}

function BuyInsuranceCard() {
  const action = useAction();
  const [flightId, setFlightId] = useState("");
  const [origin, setOrigin] = useState("");
  const [dest, setDest] = useState("");
  const [date, setDate] = useState("");
  const [precheck, setPrecheck] = useState<string | null>(null);

  if (!action.address) return null;
  const address = action.address;

  const buy = async () => {
    setPrecheck(null);
    action.setStatus({ kind: "idle" });
    // Pre-flight checks so the user gets a clear reason instead of a raw
    // contract error: route must be active and the sale window open.
    try {
      action.setBusy(true);
      const [route, saleOpen] = await Promise.all([
        fetchRouteStatus(flightId, origin, dest),
        simulateRead(CONTRACTS.oracle_aggregator.address, "is_sale_open", [
          sym(flightId),
          u64v(dateStringToUnixDay(date)),
        ]) as Promise<boolean>,
      ]);
      if (route.status !== "Active") {
        setPrecheck(
          route.status === "Disabled"
            ? "This route is currently disabled in governance."
            : "This route is not whitelisted in governance — check flight_id / origin / dest.",
        );
        return;
      }
      if (!saleOpen) {
        setPrecheck(
          "No open sale window for this flight and date. The oracle opens sales close to departure; try an active flight from the Global State page.",
        );
        return;
      }
      setPrecheck(
        `Route active: premium ${formatAmount(route.terms!.premium, 7)} USDC, payoff ${formatAmount(route.terms!.payoff, 7)} USDC after a ${route.terms!.delayHours}h delay. Submitting…`,
      );
    } catch (e) {
      setPrecheck(e instanceof Error ? e.message : String(e));
      return;
    } finally {
      action.setBusy(false);
    }

    await action.run(
      CONTRACTS.controller.address,
      "buy_insurance",
      [
        addr(address),
        sym(flightId),
        sym(origin),
        sym(dest),
        u64v(dateStringToUnixDay(date)),
      ],
      "Insurance purchased — the premium was pulled from your USDC balance and your policy is recorded.",
    );
  };

  return (
    <section className="panel">
      <h2 className="panel-title">
        <FaPlaneDeparture size={16} /> Buy Flight-Delay Insurance
      </h2>
      <p className="panel-sub">
        One signature: the premium is pulled from your USDC, the payoff is
        collateralized in the vault, and your policy is recorded. You need an
        open sale window (see Active Flights) and a whitelisted route.
      </p>
      <div className="grid-4" style={{ alignItems: "end" }}>
        <div>
          <label className="field-label">flight_id</label>
          <input value={flightId} onChange={(e) => setFlightId(e.target.value)} placeholder="e.g. AA100" spellCheck={false} />
        </div>
        <div>
          <label className="field-label">origin</label>
          <input value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="e.g. JFK" spellCheck={false} />
        </div>
        <div>
          <label className="field-label">dest</label>
          <input value={dest} onChange={(e) => setDest(e.target.value)} placeholder="e.g. LAX" spellCheck={false} />
        </div>
        <div>
          <label className="field-label">date (UTC)</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <button
          className="btn"
          onClick={() => void buy()}
          disabled={action.busy || !flightId || !origin || !dest || !date}
        >
          Buy insurance
        </button>
      </div>
      {precheck && <div className="result-box pending">{precheck}</div>}
      <StatusBox status={action.status} />
    </section>
  );
}

function PoliciesCard() {
  const action = useAction();
  const policies = useAsync(
    async () => (action.address ? fetchMyPolicies(action.address) : null),
    [action.address],
  );

  if (!action.address) return null;
  const address = action.address;

  const claimable = (status: string, expiry: bigint, hasClaimed: boolean) =>
    !hasClaimed &&
    (status === "SettledDelayed" || status === "SettledCancelled") &&
    BigInt(Math.floor(Date.now() / 1000)) < expiry;

  return (
    <section className="panel">
      <h2 className="panel-title">
        <FaFileContract size={16} /> My Policies
        <button className="icon-btn" onClick={policies.reload} aria-label="Reload" style={{ marginLeft: "auto" }}>
          <FaArrowRotateRight size={13} />
        </button>
      </h2>
      {policies.error && <div className="result-box error">{policies.error}</div>}
      {policies.loading ? (
        <p className="muted">Loading your policies…</p>
      ) : !policies.data || policies.data.length === 0 ? (
        <p className="muted">No policies yet — buy one above.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Flight</th>
                <th>Date</th>
                <th>Oracle status</th>
                <th>Pool status</th>
                <th>Payoff</th>
                <th>Claim</th>
              </tr>
            </thead>
            <tbody>
              {policies.data.map((p) => {
                const cfg = p.detail.config;
                const canClaim = cfg
                  ? claimable(cfg.status, cfg.claimExpiry, p.hasClaimed)
                  : false;
                return (
                  <tr key={`${p.flightId}-${p.date}`}>
                    <td className="mono">{p.flightId}</td>
                    <td className="mono">{unixToDateString(p.date)}</td>
                    <td>{p.detail.status}</td>
                    <td>{cfg?.status ?? "—"}</td>
                    <td>{cfg ? `${formatAmount(cfg.payoff, 7)} USDC` : "—"}</td>
                    <td>
                      {p.hasClaimed ? (
                        <span className="ok">claimed ✓</span>
                      ) : canClaim ? (
                        <button
                          className="btn btn-sm"
                          disabled={action.busy}
                          onClick={() =>
                            void action.run(
                              CONTRACTS.flight_pool_manager.address,
                              "claim",
                              [addr(address), sym(p.flightId), u64v(p.date)],
                              `Payout for ${p.flightId} claimed to your USDC balance.`,
                              policies.reload,
                            )
                          }
                        >
                          Claim payout
                        </button>
                      ) : cfg && cfg.claimExpiry > 0n ? (
                        <span className="muted" style={{ fontSize: 12 }}>
                          window: {formatTimestamp(cfg.claimExpiry)}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <StatusBox status={action.status} />
    </section>
  );
}

function VaultCard() {
  const action = useAction();
  const position = useAsync(
    async () => (action.address ? fetchVaultPosition(action.address) : null),
    [action.address],
  );
  const [depositAmount, setDepositAmount] = useState("");
  const [requestShares, setRequestShares] = useState("");

  if (!action.address) return null;
  const address = action.address;
  const v = CONTRACTS.risk_vault.address;

  return (
    <section className="panel">
      <h2 className="panel-title">
        <FaVault size={16} /> My Vault Position
        <button className="icon-btn" onClick={position.reload} aria-label="Reload" style={{ marginLeft: "auto" }}>
          <FaArrowRotateRight size={13} />
        </button>
      </h2>
      {position.error && <div className="result-box error">{position.error}</div>}
      {position.data && (
        <div className="grid-3" style={{ marginBottom: 18 }}>
          <div className="stat">
            <div className="k">My shares</div>
            <div className="v">{formatAmount(position.data.shares, 10)}</div>
            <div className="hint">RVS</div>
          </div>
          <div className="stat">
            <div className="k">Share value</div>
            <div className="v">{formatAmount(position.data.shareValueAssets, 7)}</div>
            <div className="hint">USDC at current price</div>
          </div>
          <div className="stat">
            <div className="k">Claimable (processed)</div>
            <div className="v">{formatAmount(position.data.claimable, 7)}</div>
            <div className="hint">USDC — collect below</div>
          </div>
        </div>
      )}

      <div className="grid-2">
        <div>
          <label className="field-label">Request deposit (USDC, minted as RVS after the pricing delay)</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              placeholder="USDC, e.g. 1000"
              spellCheck={false}
            />
            <button
              className="btn btn-sm"
              disabled={action.busy || !depositAmount}
              onClick={() => {
                let scaled: bigint;
                try {
                  scaled = parseAmount(depositAmount, 7);
                } catch (e) {
                  action.setStatus({ kind: "error", text: e instanceof Error ? e.message : String(e) });
                  return;
                }
                void action.run(
                  v,
                  "request_deposit",
                  [addr(address), i128v(scaled)],
                  "Deposit request queued. The keeper mints your RVS shares once the request matures past the pricing delay.",
                  position.reload,
                );
              }}
            >
              Request
            </button>
          </div>
        </div>
        <div>
          <label className="field-label">Request withdrawal (RVS shares, FIFO queue)</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={requestShares}
              onChange={(e) => setRequestShares(e.target.value)}
              placeholder="shares, e.g. 100"
              spellCheck={false}
            />
            <button
              className="btn btn-sm"
              disabled={action.busy || !requestShares}
              onClick={() => {
                let scaled: bigint;
                try {
                  scaled = parseAmount(requestShares, 10);
                } catch (e) {
                  action.setStatus({ kind: "error", text: e instanceof Error ? e.message : String(e) });
                  return;
                }
                void action.run(
                  v,
                  "request_withdrawal",
                  [addr(address), i128v(scaled)],
                  "Withdrawal request queued. The keeper processes the queue; collect your USDC here once processed.",
                  position.reload,
                );
              }}
            >
              Request
            </button>
          </div>
        </div>
      </div>

      {position.data && position.data.queued.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <label className="field-label">My queued requests</label>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Request ID</th>
                  <th>Shares</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {position.data.queued.map((q) => (
                  <tr key={q.requestId.toString()}>
                    <td className="mono">{q.requestId.toString()}</td>
                    <td>{formatAmount(q.shares, 10)} RVS</td>
                    <td>
                      <button
                        className="btn btn-outline btn-sm"
                        disabled={action.busy}
                        onClick={() =>
                          void action.run(
                            v,
                            "cancel_withdrawal",
                            [addr(address), u64v(q.requestId)],
                            "Request cancelled — shares returned to your balance.",
                            position.reload,
                          )
                        }
                      >
                        Cancel
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {position.data && position.data.claimable > 0n && (
        <div style={{ marginTop: 18 }}>
          <button
            className="btn"
            disabled={action.busy}
            onClick={() =>
              void action.run(
                v,
                "collect",
                [addr(address)],
                "Collected — USDC transferred to your account.",
                position.reload,
              )
            }
          >
            Collect {formatAmount(position.data.claimable, 7)} USDC
          </button>
        </div>
      )}

      <p className="muted" style={{ fontSize: 13, marginTop: 16 }}>
        All LP entry and exit is two-phase: requests escrow value immediately
        and are priced by the keeper only after a delay, so nobody can trade
        on a flight outcome before the oracle records it. Queued deposit
        requests can be cancelled from the Interact page (cancel_deposit).
      </p>
      <StatusBox status={action.status} />
    </section>
  );
}

export default function AccountPage() {
  const { address, connect, connecting } = useWallet();

  return (
    <>
      <h1 className="page-title">My Account</h1>
      <p className="page-sub">
        Your balances, policies and vault position on the Sentinel testnet
        deployment. Every transaction is simulated first and signed in your
        wallet — this site never handles keys.
      </p>
      {!address ? (
        <section className="panel" style={{ textAlign: "center", padding: 48 }}>
          <FaWallet size={28} style={{ color: "var(--accent)", marginBottom: 12 }} />
          <p style={{ marginBottom: 18 }}>Connect a wallet to see your account.</p>
          <button className="btn" onClick={() => void connect().catch(() => {})} disabled={connecting}>
            {connecting ? "Connecting…" : "Connect Wallet"}
          </button>
        </section>
      ) : (
        <>
          <BalancesCard />
          <BuyInsuranceCard />
          <PoliciesCard />
          <VaultCard />
        </>
      )}
    </>
  );
}

"use client";

// Global State — the protocol-wide dashboard: totals, vault health,
// pause switches, active flights and a route-terms checker.

import { useState } from "react";
import {
  FaArrowRotateRight,
  FaCircleCheck,
  FaCoins,
  FaFileContract,
  FaGears,
  FaLock,
  FaLockOpen,
  FaMagnifyingGlass,
  FaPlaneDeparture,
  FaSatelliteDish,
  FaScaleBalanced,
  FaTriangleExclamation,
  FaVault,
} from "react-icons/fa6";
import { AddressLine } from "@/components/AddressLine";
import {
  ACCOUNTS,
  CONTRACTS,
  PARAMETERS,
  explorerAccountUrl,
  explorerContractUrl,
} from "@/lib/config";
import {
  formatAmount,
  formatTimestamp,
  unixToDateString,
} from "@/lib/format";
import {
  fetchActiveFlights,
  fetchFlightDetail,
  fetchGovernanceDefaults,
  fetchProtocolStats,
  fetchRouteStatus,
  fetchVaultStats,
  type FlightDetail,
  type RouteInfo,
} from "@/lib/queries";
import { useAsync } from "@/lib/useAsync";

function Loading({ error }: { error: string | null }) {
  return error ? (
    <div className="result-box error">{error}</div>
  ) : (
    <p className="muted">Loading on-chain state…</p>
  );
}

function ProtocolSection() {
  const { data, loading, error, reload } = useAsync(fetchProtocolStats);
  return (
    <section className="panel">
      <h2 className="panel-title">
        <FaGears size={16} /> Protocol
        <button className="icon-btn" onClick={reload} aria-label="Reload" style={{ marginLeft: "auto" }}>
          <FaArrowRotateRight size={13} />
        </button>
      </h2>
      {!data ? (
        loading ? <Loading error={null} /> : <Loading error={error} />
      ) : (
        <>
          <div className="grid-4">
            <div className="stat">
              <div className="k"><FaFileContract size={12} /> Policies sold</div>
              <div className="v">{data.policiesSold.toString()}</div>
            </div>
            <div className="stat">
              <div className="k"><FaCoins size={12} /> Premiums collected</div>
              <div className="v">{formatAmount(data.premiumsCollected, 7)}</div>
              <div className="hint">USDC</div>
            </div>
            <div className="stat">
              <div className="k"><FaCoins size={12} /> Payouts distributed</div>
              <div className="v">{formatAmount(data.payoutsDistributed, 7)}</div>
              <div className="hint">USDC</div>
            </div>
            <div className="stat">
              <div className="k"><FaScaleBalanced size={12} /> Solvency ratio</div>
              <div className="v">{data.solvencyRatio}%</div>
            </div>
          </div>
          <div style={{ marginTop: 16, display: "flex", gap: 18, flexWrap: "wrap", fontSize: 14 }}>
            <span>
              Pending outcomes:{" "}
              <strong className={data.pendingOutcomes > 0n ? "accent" : ""}>
                {data.pendingOutcomes.toString()}
              </strong>
            </span>
            <span>
              Buyer whitelist:{" "}
              <strong>{data.whitelistEnabled ? "enabled" : "disabled"}</strong>
            </span>
            <span className="muted">
              Keeper: <AddressLine address={data.keeper} explorerUrl={explorerAccountUrl(data.keeper)} />
            </span>
          </div>
          <div style={{ marginTop: 14, display: "flex", gap: 12, flexWrap: "wrap" }}>
            {data.pausedStates.map((p) => (
              <span key={p.label} className={`badge ${p.paused ? "owner" : "public"}`}>
                {p.paused ? <FaLock size={9} /> : <FaLockOpen size={9} />} {p.label}:{" "}
                {p.paused ? "PAUSED" : "live"}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function VaultSection() {
  const { data, loading, error, reload } = useAsync(fetchVaultStats);
  return (
    <section className="panel">
      <h2 className="panel-title">
        <FaVault size={16} /> Risk Vault
        <button className="icon-btn" onClick={reload} aria-label="Reload" style={{ marginLeft: "auto" }}>
          <FaArrowRotateRight size={13} />
        </button>
      </h2>
      {!data ? (
        loading ? <Loading error={null} /> : <Loading error={error} />
      ) : (
        <div className="grid-4">
          <div className="stat">
            <div className="k">Total managed assets</div>
            <div className="v">{formatAmount(data.totalManagedAssets, 7)}</div>
            <div className="hint">USDC</div>
          </div>
          <div className="stat">
            <div className="k">Locked collateral</div>
            <div className="v">{formatAmount(data.lockedCapital, 7)}</div>
            <div className="hint">backing live policies</div>
          </div>
          <div className="stat">
            <div className="k">Free capital</div>
            <div className="v">{formatAmount(data.freeCapital, 7)}</div>
            <div className="hint">USDC available for new policies / exits</div>
          </div>
          <div className="stat">
            <div className="k">Share price</div>
            <div className="v">
              {formatAmount(data.sharePriceAssetsPerShareUnit, 7)}
            </div>
            <div className="hint">USDC per 1 RVS share</div>
          </div>
          <div className="stat">
            <div className="k">Total shares</div>
            <div className="v">{formatAmount(data.totalShares, 10)}</div>
            <div className="hint">RVS</div>
          </div>
          <div className="stat">
            <div className="k">Withdrawal queue</div>
            <div className="v">{data.queueLength}</div>
            <div className="hint">pending requests</div>
          </div>
          <div className="stat">
            <div className="k">Min withdrawal request</div>
            <div className="v">{formatAmount(data.minWithdrawalRequest, 7)}</div>
            <div className="hint">USDC</div>
          </div>
        </div>
      )}
    </section>
  );
}

function FlightRow({ flightId, date }: { flightId: string; date: bigint }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<FlightDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const toggle = async () => {
    setOpen((o) => !o);
    if (!detail && !err) {
      try {
        setDetail(await fetchFlightDetail(flightId, date));
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    }
  };

  return (
    <>
      <tr onClick={() => void toggle()} style={{ cursor: "pointer" }}>
        <td className="mono">{flightId}</td>
        <td className="mono">{unixToDateString(date)}</td>
        <td className="muted">{open ? "click to collapse" : "click for details"}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={3}>
            {err ? (
              <span className="danger">{err}</span>
            ) : !detail ? (
              <span className="muted">Loading…</span>
            ) : (
              <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 13, padding: "4px 0" }}>
                <span>Oracle status: <strong className="accent">{detail.status}</strong></span>
                <span>Sale open: <strong>{detail.saleOpen ? "yes" : "no"}</strong></span>
                <span>Scheduled arrival: {formatTimestamp(detail.estimatedArrivalTime)}</span>
                <span>Actual arrival: {formatTimestamp(detail.actualArrivalTime)}</span>
                {detail.config ? (
                  <>
                    <span>Premium: {formatAmount(detail.config.premium, 7)} USDC</span>
                    <span>Payoff: {formatAmount(detail.config.payoff, 7)} USDC</span>
                    <span>Delay threshold: {detail.config.delayHours}h</span>
                    <span>Buyers: {detail.config.buyerCount}</span>
                    <span>Claimed: {detail.config.claimedCount}</span>
                    <span>Pool status: <strong>{detail.config.status}</strong></span>
                    {detail.config.claimExpiry > 0n && (
                      <span>Claim expiry: {formatTimestamp(detail.config.claimExpiry)}</span>
                    )}
                  </>
                ) : (
                  <span className="muted">No pool record (never purchased)</span>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function ActiveFlightsSection() {
  const { data, loading, error, reload } = useAsync(fetchActiveFlights);
  return (
    <section className="panel">
      <h2 className="panel-title">
        <FaPlaneDeparture size={16} /> Active Flights
        <button className="icon-btn" onClick={reload} aria-label="Reload" style={{ marginLeft: "auto" }}>
          <FaArrowRotateRight size={13} />
        </button>
      </h2>
      <p className="panel-sub">
        Flights currently tracked by the oracle. Click a row to load its live
        status and policy pool.
      </p>
      {!data ? (
        loading ? <Loading error={null} /> : <Loading error={error} />
      ) : data.length === 0 ? (
        <p className="muted">No active flights right now.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Flight</th>
                <th>Date (UTC)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.map((f) => (
                <FlightRow key={`${f.flightId}-${f.date}`} flightId={f.flightId} date={f.date} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RouteCheckerSection() {
  const defaults = useAsync(fetchGovernanceDefaults);
  const [flightId, setFlightId] = useState("");
  const [origin, setOrigin] = useState("");
  const [dest, setDest] = useState("");
  const [result, setResult] = useState<RouteInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      setResult(await fetchRouteStatus(flightId, origin, dest));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2 className="panel-title">
        <FaMagnifyingGlass size={15} /> Route Checker
      </h2>
      <p className="panel-sub">
        Look up whether a route is insurable and at what terms.
        {defaults.data && (
          <>
            {" "}Global defaults: premium{" "}
            <strong>{formatAmount(defaults.data.premium, 7)} USDC</strong>, payoff{" "}
            <strong>{formatAmount(defaults.data.payoff, 7)} USDC</strong>, delay
            threshold <strong>{defaults.data.delayHours}h</strong>.
          </>
        )}
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
        <button className="btn" onClick={() => void check()} disabled={busy || !flightId || !origin || !dest}>
          {busy ? "Checking…" : "Check route"}
        </button>
      </div>
      {err && <div className="result-box error">{err}</div>}
      {result && (
        <div className="result-box">
          {result.status === "Active" && result.terms ? (
            <>
              <FaCircleCheck style={{ color: "var(--ok)", marginRight: 6 }} />
              Route is ACTIVE — premium {formatAmount(result.terms.premium, 7)} USDC,
              payoff {formatAmount(result.terms.payoff, 7)} USDC, pays out after a{" "}
              {result.terms.delayHours}h delay (or cancellation).
            </>
          ) : result.status === "Disabled" ? (
            <>
              <FaTriangleExclamation style={{ color: "var(--danger)", marginRight: 6 }} />
              Route exists but is DISABLED — purchases are blocked.
            </>
          ) : (
            <>Route is UNKNOWN — it has not been whitelisted in governance.</>
          )}
        </div>
      )}
    </section>
  );
}

function DeploymentSection() {
  return (
    <section className="panel">
      <h2 className="panel-title">
        <FaSatelliteDish size={15} /> Deployment
      </h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Contract</th>
              <th>Address</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            {Object.values(CONTRACTS).map((c) => (
              <tr key={c.address}>
                <td style={{ whiteSpace: "nowrap" }}>{c.label}</td>
                <td>
                  <AddressLine address={c.address} explorerUrl={explorerContractUrl(c.address)} />
                </td>
                <td className="muted" style={{ fontSize: 13 }}>{c.description}</td>
              </tr>
            ))}
            {Object.entries(ACCOUNTS).map(([name, address]) => (
              <tr key={address}>
                <td style={{ whiteSpace: "nowrap" }} className="muted">{name.replace("_", " ")}</td>
                <td>
                  <AddressLine address={address} explorerUrl={explorerAccountUrl(address)} />
                </td>
                <td className="muted" style={{ fontSize: 13 }}>protocol account</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
        Deployment parameters: min lead time {PARAMETERS.min_lead_time_secs / 3600}h ·
        claim window {PARAMETERS.claim_expiry_window_secs / 86400} days ·
        min withdrawal request {formatAmount(PARAMETERS.min_withdrawal_request, 7)} USDC ·
        solvency ratio {PARAMETERS.solvency_ratio}%
      </p>
    </section>
  );
}

export default function GlobalStatePage() {
  return (
    <>
      <h1 className="page-title">Global State</h1>
      <p className="page-sub">
        Live protocol state on Stellar testnet, read directly from the Sentinel
        contracts via free RPC simulations — no wallet required.
      </p>
      <ProtocolSection />
      <VaultSection />
      <ActiveFlightsSection />
      <RouteCheckerSection />
      <DeploymentSection />
    </>
  );
}

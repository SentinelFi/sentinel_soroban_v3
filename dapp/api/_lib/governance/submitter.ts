import { Keypair } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import {
  Client as GovernanceClient,
  type DelayHoursUpdate,
  type PremiumUpdate,
  type RouteStatus,
} from "governance_module";
import type { OnChainRoute } from "../governance";
import { logAction } from "./action_log";
import type { RouteKey } from "./model";

/**
 * GovSubmitter — the single choke point for on-chain governance
 * mutations. Reconciler rules and admin API routes both go through
 * here so every call is identically audited:
 *
 * 1. Snapshot route_status (before).
 * 2. Submit the contract call with the gov-admin key.
 * 3. Snapshot route_status (after).
 * 4. Append to actions_log — actor, entry point, tx hash,
 *    before/after, outcome. A failed submit is logged too.
 *
 * Built on the GENERATED bindings client (dapp/packages/
 * governance_module — regenerate with `stellar contract bindings
 * typescript --id <GOVERNANCE_ID> --network testnet` or
 * rebuild-bindings.sh), not the hand-rolled ScVal helpers in
 * ../governance.ts: the Keep | Set | UseDefault unions are then
 * compiler-checked against the deployed contract spec. The old
 * helpers remain only for route_agent until Phase 4 absorbs it.
 *
 * Audit writes never mask the on-chain outcome: a DB blip is
 * console-logged and the tx result still returned/thrown.
 */

export interface GovSubmitterOpts {
  rpcUrl: string;
  networkPassphrase: string;
  governanceId: string;
  /** The gov-admin key (GovernanceModule ADMIN) — never the owner. */
  adminSecretKey: string;
  /** 'cron:<rule>' or 'admin:<email>' — recorded on every log row. */
  actor: string;
}

export interface SubmitOutcome {
  txHash: string | null;
  before: OnChainRoute;
  after: OnChainRoute;
}

/** Per-field terms op, mirroring the contract's Keep | Set | UseDefault. */
export type PremiumOp = bigint | "keep" | "use_default";
export type DelayOp = number | "keep" | "use_default";

// Soroban tx fees are simulation-priced; this is the max INCLUSION fee,
// same 1-XLM posture as SorobanClient.invokeContract.
const MAX_FEE = "10000000";

export class GovSubmitter {
  private client: GovernanceClient;
  private caller: string;
  private actor: string;

  constructor(opts: GovSubmitterOpts) {
    const keypair = Keypair.fromSecret(opts.adminSecretKey);
    this.caller = keypair.publicKey();
    this.actor = opts.actor;
    this.client = new GovernanceClient({
      contractId: opts.governanceId,
      networkPassphrase: opts.networkPassphrase,
      rpcUrl: opts.rpcUrl,
      publicKey: this.caller,
      ...basicNodeSigner(keypair, opts.networkPassphrase),
    });
  }

  async readStatus(key: RouteKey): Promise<OnChainRoute> {
    const tx = await this.client.route_status({
      flight_id: key.flightId,
      origin: key.origin,
      dest: key.dest,
    });
    return fromRouteStatus(tx.result);
  }

  async whitelist(
    key: RouteKey,
    premium: bigint | null,
    payoff: bigint | null,
    delayHours: number | null
  ): Promise<SubmitOutcome> {
    return this.submit(key, "whitelist_route", () =>
      this.client.whitelist_route(
        {
          caller: this.caller,
          flight_id: key.flightId,
          origin: key.origin,
          dest: key.dest,
          premium: premium ?? undefined,
          payoff: payoff ?? undefined,
          delay_hours: delayHours ?? undefined,
        },
        { fee: MAX_FEE }
      )
    );
  }

  async disable(key: RouteKey): Promise<SubmitOutcome> {
    return this.submit(key, "disable_route", () =>
      this.client.disable_route(
        { caller: this.caller, flight_id: key.flightId, origin: key.origin, dest: key.dest },
        { fee: MAX_FEE }
      )
    );
  }

  async enable(key: RouteKey): Promise<SubmitOutcome> {
    return this.submit(key, "enable_route", () =>
      this.client.enable_route(
        { caller: this.caller, flight_id: key.flightId, origin: key.origin, dest: key.dest },
        { fee: MAX_FEE }
      )
    );
  }

  async remove(key: RouteKey): Promise<SubmitOutcome> {
    return this.submit(key, "remove_route", () =>
      this.client.remove_route(
        { caller: this.caller, flight_id: key.flightId, origin: key.origin, dest: key.dest },
        { fee: MAX_FEE }
      )
    );
  }

  async updateTerms(
    key: RouteKey,
    premium: PremiumOp,
    payoff: PremiumOp,
    delayHours: DelayOp
  ): Promise<SubmitOutcome> {
    return this.submit(key, "update_route_terms", () =>
      this.client.update_route_terms(
        {
          caller: this.caller,
          flight_id: key.flightId,
          origin: key.origin,
          dest: key.dest,
          premium: toPremiumUpdate(premium),
          payoff: toPremiumUpdate(payoff),
          delay_hours: toDelayUpdate(delayHours),
        },
        { fee: MAX_FEE }
      )
    );
  }

  /** Revert a route to base economics: all fields UseDefault. */
  async revertTerms(key: RouteKey): Promise<SubmitOutcome> {
    return this.updateTerms(key, "use_default", "use_default", "use_default");
  }

  private async submit(
    key: RouteKey,
    action: string,
    build: () => Promise<{ signAndSend: () => Promise<any> }>
  ): Promise<SubmitOutcome> {
    // 1. before snapshot
    const before = await this.readStatus(key);

    // 2. simulate, sign, submit
    let txHash: string | null = null;
    try {
      const sent = await (await build()).signAndSend();
      txHash = sent.sendTransactionResponse?.hash ?? null;
    } catch (err) {
      await this.safeLog(key, action, txHash, before, null, false, String(err));
      throw err;
    }

    // 3. after snapshot — best-effort; the tx already succeeded
    let after: OnChainRoute = { status: "Unknown", terms: null };
    try {
      after = await this.readStatus(key);
    } catch (err) {
      console.warn(`[gov-submitter] after-snapshot failed for ${action}: ${err}`);
    }

    // 4. audit
    await this.safeLog(key, action, txHash, before, after, true, null);
    return { txHash, before, after };
  }

  private async safeLog(
    key: RouteKey,
    action: string,
    txHash: string | null,
    before: OnChainRoute | null,
    after: OnChainRoute | null,
    success: boolean,
    error: string | null
  ): Promise<void> {
    try {
      await logAction({
        actor: this.actor,
        action,
        flightId: key.flightId,
        origin: key.origin,
        dest: key.dest,
        txHash,
        before: serializeRoute(before),
        after: serializeRoute(after),
        success,
        error,
      });
    } catch (err) {
      console.error(`[gov-submitter] actions_log write failed for ${action}: ${err}`);
    }
  }
}

function toPremiumUpdate(op: PremiumOp): PremiumUpdate {
  if (op === "keep") return { tag: "Keep", values: undefined };
  if (op === "use_default") return { tag: "UseDefault", values: undefined };
  return { tag: "Set", values: [op] };
}

function toDelayUpdate(op: DelayOp): DelayHoursUpdate {
  if (op === "keep") return { tag: "Keep", values: undefined };
  if (op === "use_default") return { tag: "UseDefault", values: undefined };
  return { tag: "Set", values: [op] };
}

/** Generated union → the shared OnChainRoute shape used across _lib. */
function fromRouteStatus(raw: RouteStatus): OnChainRoute {
  if (raw.tag === "Active") {
    const t = raw.values[0];
    return {
      status: "Active",
      terms: {
        premium: BigInt(t.premium),
        payoff: BigInt(t.payoff),
        delayHours: Number(t.delay_hours),
      },
    };
  }
  return { status: raw.tag, terms: null };
}

/** OnChainRoute → JSON-safe shape (bigint terms become strings). */
function serializeRoute(r: OnChainRoute | null): unknown {
  if (!r) return null;
  return {
    status: r.status,
    terms: r.terms
      ? {
          premium: r.terms.premium.toString(),
          payoff: r.terms.payoff.toString(),
          delayHours: r.terms.delayHours,
        }
      : null,
  };
}

import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { SorobanClient } from "./soroban_client";

/**
 * GovernanceModule client helpers — route whitelist / terms mutations and
 * the route_status query. Raw ScVal construction mirrors the contract:
 *
 *   whitelist_route(caller, flight_id, origin, dest,
 *                   premium: Option<i128>, payoff: Option<i128>,
 *                   delay_hours: Option<u32>)
 *   disable_route(caller, flight_id, origin, dest)
 *   enable_route(caller, flight_id, origin, dest)
 *   update_route_terms(caller, flight_id, origin, dest,
 *                      premium: PremiumUpdate, payoff: PayoffUpdate,
 *                      delay_hours: DelayHoursUpdate)
 *   route_status(flight_id, origin, dest) -> Active(ResolvedTerms) | Disabled | Unknown
 *
 * The *Update enums are Keep | Set(v) | UseDefault — Soroban unions encode
 * as ScVec([Symbol, ...payload]).
 */

// ── ScVal builders ─────────────────────────────────────────────────

export function optionI128(v: bigint | null): xdr.ScVal {
  return v === null ? xdr.ScVal.scvVoid() : nativeToScVal(v, { type: "i128" });
}

export function optionU32(v: number | null): xdr.ScVal {
  return v === null ? xdr.ScVal.scvVoid() : nativeToScVal(v, { type: "u32" });
}

/** PremiumUpdate / PayoffUpdate union: Keep | Set(i128) | UseDefault. */
export function i128Update(v: bigint | "keep" | "use_default"): xdr.ScVal {
  if (v === "keep") return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Keep")]);
  if (v === "use_default") return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("UseDefault")]);
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Set"), nativeToScVal(v, { type: "i128" })]);
}

/** DelayHoursUpdate union: Keep | Set(u32) | UseDefault. */
export function u32Update(v: number | "keep" | "use_default"): xdr.ScVal {
  if (v === "keep") return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Keep")]);
  if (v === "use_default") return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("UseDefault")]);
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Set"), nativeToScVal(v, { type: "u32" })]);
}

// ── route_status parsing ───────────────────────────────────────────

export interface OnChainRoute {
  status: "Active" | "Disabled" | "Unknown";
  /** Resolved terms (defaults folded on-chain) — only when Active. */
  terms: { premium: bigint; payoff: bigint; delayHours: number } | null;
}

/**
 * Tolerant decoding of the RouteStatus union: scValToNative returns
 * ["Active", {premium,...}] / ["Disabled"] / "Unknown" / {Active: {...}}
 * depending on SDK version — handle all shapes (same posture as
 * parseFlightStatus).
 */
export function parseRouteStatus(raw: any): OnChainRoute {
  let tag: string | undefined;
  let payload: any;

  if (typeof raw === "string") {
    tag = raw;
  } else if (Array.isArray(raw)) {
    tag = raw[0];
    payload = raw[1];
  } else if (typeof raw === "object" && raw !== null) {
    const keys = Object.keys(raw);
    if (keys.length === 1) {
      tag = keys[0];
      payload = raw[tag];
    }
  }

  if (tag === "Active") {
    return {
      status: "Active",
      terms: payload
        ? {
            premium: BigInt(payload.premium ?? 0),
            payoff: BigInt(payload.payoff ?? 0),
            delayHours: Number(payload.delay_hours ?? 0),
          }
        : null,
    };
  }
  if (tag === "Disabled") return { status: "Disabled", terms: null };
  return { status: "Unknown", terms: null };
}

// ── contract calls ─────────────────────────────────────────────────

export interface GovernanceCtx {
  client: SorobanClient;
  governanceId: string;
  adminPublicKey: string;
  adminSecretKey: string;
}

export async function readRouteStatus(
  ctx: Pick<GovernanceCtx, "client" | "governanceId">,
  flightId: string,
  origin: string,
  dest: string
): Promise<OnChainRoute> {
  const raw = await ctx.client.readContract(ctx.governanceId, "route_status", [
    ctx.client.symbolToScVal(flightId),
    ctx.client.symbolToScVal(origin),
    ctx.client.symbolToScVal(dest),
  ]);
  return parseRouteStatus(raw);
}

export async function whitelistRoute(
  ctx: GovernanceCtx,
  flightId: string,
  origin: string,
  dest: string,
  premium: bigint | null,
  payoff: bigint | null,
  delayHours: number | null
): Promise<any> {
  return ctx.client.invokeContract(
    ctx.governanceId,
    "whitelist_route",
    [
      ctx.client.addressToScVal(ctx.adminPublicKey),
      ctx.client.symbolToScVal(flightId),
      ctx.client.symbolToScVal(origin),
      ctx.client.symbolToScVal(dest),
      optionI128(premium),
      optionI128(payoff),
      optionU32(delayHours),
    ],
    ctx.adminSecretKey
  );
}

export async function disableRoute(
  ctx: GovernanceCtx,
  flightId: string,
  origin: string,
  dest: string
): Promise<any> {
  return ctx.client.invokeContract(
    ctx.governanceId,
    "disable_route",
    [
      ctx.client.addressToScVal(ctx.adminPublicKey),
      ctx.client.symbolToScVal(flightId),
      ctx.client.symbolToScVal(origin),
      ctx.client.symbolToScVal(dest),
    ],
    ctx.adminSecretKey
  );
}

export async function enableRoute(
  ctx: GovernanceCtx,
  flightId: string,
  origin: string,
  dest: string
): Promise<any> {
  return ctx.client.invokeContract(
    ctx.governanceId,
    "enable_route",
    [
      ctx.client.addressToScVal(ctx.adminPublicKey),
      ctx.client.symbolToScVal(flightId),
      ctx.client.symbolToScVal(origin),
      ctx.client.symbolToScVal(dest),
    ],
    ctx.adminSecretKey
  );
}

export async function updateRoutePremium(
  ctx: GovernanceCtx,
  flightId: string,
  origin: string,
  dest: string,
  newPremium: bigint
): Promise<any> {
  return updateRouteTerms(ctx, flightId, origin, dest, newPremium, "keep", "keep");
}

/** Full per-field terms update — each field is Keep | Set(v) | UseDefault. */
export async function updateRouteTerms(
  ctx: GovernanceCtx,
  flightId: string,
  origin: string,
  dest: string,
  premium: bigint | "keep" | "use_default",
  payoff: bigint | "keep" | "use_default",
  delayHours: number | "keep" | "use_default"
): Promise<any> {
  return ctx.client.invokeContract(
    ctx.governanceId,
    "update_route_terms",
    [
      ctx.client.addressToScVal(ctx.adminPublicKey),
      ctx.client.symbolToScVal(flightId),
      ctx.client.symbolToScVal(origin),
      ctx.client.symbolToScVal(dest),
      i128Update(premium),
      i128Update(payoff),
      u32Update(delayHours),
    ],
    ctx.adminSecretKey
  );
}

export async function removeRoute(
  ctx: GovernanceCtx,
  flightId: string,
  origin: string,
  dest: string
): Promise<any> {
  return ctx.client.invokeContract(
    ctx.governanceId,
    "remove_route",
    [
      ctx.client.addressToScVal(ctx.adminPublicKey),
      ctx.client.symbolToScVal(flightId),
      ctx.client.symbolToScVal(origin),
      ctx.client.symbolToScVal(dest),
    ],
    ctx.adminSecretKey
  );
}

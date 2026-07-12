// Encoding of typed form inputs into Soroban ScVals, driven by the
// contract registry's ArgType descriptors. Validation is strict: bad
// input throws with a human-readable message before anything is signed.

import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { parseAmount, dateStringToUnixDay } from "@/lib/format";

export type ArgType =
  | "address"
  | "symbol"
  | "bool"
  | "u32"
  | "u64"
  | "i128"
  | "amount7" // i128 scaled by 1e7 (USDC)
  | "amount10" // i128 scaled by 1e10 (vault shares)
  | "timestamp" // u64 unix seconds
  | "date" // u64 unix seconds, midnight-UTC aligned (form input: YYYY-MM-DD)
  | "bytes32" // 32-byte hex (wasm hashes)
  | { option: ArgType }
  | { enum: readonly string[] } // unit-variant enum, e.g. FlightStatus
  | {
      variant: readonly { name: string; payload?: ArgType }[];
    }; // mixed enum, e.g. PremiumUpdate = Keep | Set(i128) | UseDefault

export interface ArgValue {
  /** Raw text / select value from the form. */
  raw: string;
  /** For variant types: the payload input, when the chosen variant has one. */
  payload?: string;
}

function requireNonEmpty(raw: string, what: string): string {
  const v = raw.trim();
  if (v === "") throw new Error(`${what} is required`);
  return v;
}

function parseBigInt(raw: string, what: string): bigint {
  const v = requireNonEmpty(raw, what);
  if (!/^-?\d+$/.test(v)) throw new Error(`${what}: "${raw}" is not an integer`);
  return BigInt(v);
}

export function encodeArg(type: ArgType, value: ArgValue, name: string): xdr.ScVal {
  // Option<T>: empty input means None.
  if (typeof type === "object" && "option" in type) {
    if (value.raw.trim() === "") return xdr.ScVal.scvVoid();
    return encodeArg(type.option, value, name);
  }

  if (typeof type === "object" && "enum" in type) {
    const chosen = requireNonEmpty(value.raw, name);
    if (!type.enum.includes(chosen)) {
      throw new Error(`${name}: unknown variant "${chosen}"`);
    }
    return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(chosen)]);
  }

  if (typeof type === "object" && "variant" in type) {
    const chosen = requireNonEmpty(value.raw, name);
    const spec = type.variant.find((v) => v.name === chosen);
    if (!spec) throw new Error(`${name}: unknown variant "${chosen}"`);
    const parts = [xdr.ScVal.scvSymbol(spec.name)];
    if (spec.payload) {
      parts.push(
        encodeArg(spec.payload, { raw: value.payload ?? "" }, `${name}.${spec.name}`),
      );
    }
    return xdr.ScVal.scvVec(parts);
  }

  switch (type) {
    case "address": {
      const v = requireNonEmpty(value.raw, name);
      try {
        return Address.fromString(v).toScVal();
      } catch {
        throw new Error(`${name}: "${v}" is not a valid Stellar address (G… or C…)`);
      }
    }
    case "symbol": {
      const v = requireNonEmpty(value.raw, name);
      if (!/^[A-Za-z0-9_]{1,32}$/.test(v)) {
        throw new Error(
          `${name}: symbols allow only letters, digits and _ (max 32 chars)`,
        );
      }
      return xdr.ScVal.scvSymbol(v);
    }
    case "bool": {
      const v = requireNonEmpty(value.raw, name).toLowerCase();
      if (v !== "true" && v !== "false") {
        throw new Error(`${name}: expected true or false`);
      }
      return xdr.ScVal.scvBool(v === "true");
    }
    case "u32": {
      const n = parseBigInt(value.raw, name);
      if (n < 0n || n > 0xffffffffn) throw new Error(`${name}: out of u32 range`);
      return nativeToScVal(Number(n), { type: "u32" });
    }
    case "u64": {
      const n = parseBigInt(value.raw, name);
      if (n < 0n) throw new Error(`${name}: u64 cannot be negative`);
      return nativeToScVal(n, { type: "u64" });
    }
    case "i128": {
      return nativeToScVal(parseBigInt(value.raw, name), { type: "i128" });
    }
    case "amount7": {
      const scaled = parseAmount(requireNonEmpty(value.raw, name), 7);
      return nativeToScVal(scaled, { type: "i128" });
    }
    case "amount10": {
      const scaled = parseAmount(requireNonEmpty(value.raw, name), 10);
      return nativeToScVal(scaled, { type: "i128" });
    }
    case "timestamp": {
      const n = parseBigInt(value.raw, name);
      if (n < 0n) throw new Error(`${name}: timestamps cannot be negative`);
      return nativeToScVal(n, { type: "u64" });
    }
    case "date": {
      const secs = dateStringToUnixDay(requireNonEmpty(value.raw, name));
      return nativeToScVal(secs, { type: "u64" });
    }
    case "bytes32": {
      const v = requireNonEmpty(value.raw, name).toLowerCase().replace(/^0x/, "");
      if (!/^[0-9a-f]{64}$/.test(v)) {
        throw new Error(`${name}: expected 32 bytes as 64 hex characters`);
      }
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        bytes[i] = parseInt(v.slice(i * 2, i * 2 + 2), 16);
      }
      // nativeToScVal handles Uint8Array → ScvBytes portably (no Buffer needed).
      return nativeToScVal(bytes);
    }
    default: {
      const exhaustive: never = type;
      throw new Error(`Unsupported argument type: ${String(exhaustive)}`);
    }
  }
}

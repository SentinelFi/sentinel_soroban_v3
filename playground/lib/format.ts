// Display/parse helpers. All token math is done with BigInt — never floats.

/** Format a scaled integer amount (e.g. 7-decimals USDC) as a decimal string. */
export function formatAmount(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let out = whole.toLocaleString("en-US");
  if (frac > 0n) {
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    out += `.${fracStr}`;
  }
  return negative ? `-${out}` : out;
}

/** Parse a human decimal string into a scaled BigInt. Throws on bad input. */
export function parseAmount(raw: string, decimals: number): bigint {
  const trimmed = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`"${raw}" is not a valid decimal number`);
  }
  const negative = trimmed.startsWith("-");
  const [wholeRaw, fracRaw = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
  if (fracRaw.length > decimals) {
    throw new Error(`At most ${decimals} decimal places are supported`);
  }
  const scaled =
    BigInt(wholeRaw) * 10n ** BigInt(decimals) +
    BigInt(fracRaw.padEnd(decimals, "0") || "0");
  return negative ? -scaled : scaled;
}

/** Shorten a Stellar address for display: GCEO…E6KD */
export function shortAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 1) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

/** Unix seconds (bigint or number) → readable UTC string. */
export function formatTimestamp(secs: bigint | number): string {
  const n = Number(secs);
  if (!Number.isFinite(n) || n === 0) return "—";
  return new Date(n * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

/** "YYYY-MM-DD" → unix seconds at midnight UTC (the protocol's day-aligned date). */
export function dateStringToUnixDay(dateStr: string): bigint {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) throw new Error(`"${dateStr}" is not a valid YYYY-MM-DD date`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return BigInt(Math.floor(ms / 1000));
}

/** Unix seconds → "YYYY-MM-DD" (UTC). */
export function unixToDateString(secs: bigint | number): string {
  return new Date(Number(secs) * 1000).toISOString().slice(0, 10);
}

/** JSON.stringify that survives BigInt and keeps output compact but readable. */
export function stringifyResult(value: unknown): string {
  if (value === undefined) return "void (no return value)";
  return JSON.stringify(
    value,
    (_key, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}

/**
 * Name of a decoded Soroban enum variant. `scValToNative` decodes unit
 * variants like `Landed` to `["Landed"]` and payload variants like
 * `Active(terms)` to `["Active", {...}]`; plain strings pass through.
 */
export function variantName(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return String(value);
}

/** Payload of a decoded payload-carrying enum variant, if any. */
export function variantPayload<T = unknown>(value: unknown): T | undefined {
  if (Array.isArray(value) && value.length > 1) return value[1] as T;
  return undefined;
}

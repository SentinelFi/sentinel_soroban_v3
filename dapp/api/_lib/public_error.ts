/**
 * OCA-M05: public, unauthenticated endpoints must never echo raw internal
 * error strings (Soroban simulation dumps, DB hostnames, missing-env-var
 * names) to anonymous callers. Log the full detail server-side; return an
 * opaque message. Admin routes deliberately keep verbatim errors — they
 * sit behind verifyAdmin and the detail is what makes the board debuggable.
 */
export function publicError(scope: string, err: unknown): string {
  console.error(`[${scope}] request failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  return "internal error — please retry later";
}

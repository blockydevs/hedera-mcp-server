/**
 * Whether a request's token account differs from the account that opened the MCP session.
 *
 * Extracted as a pure predicate so the per-account isolation rule (a session may only be used
 * by the account that created it, on POST/GET/DELETE) is unit-testable without standing up
 * the server. Returns false when either side is unknown — dev mode has no token, and a
 * brand-new session has no binding yet.
 */
export function isForeignSession(
  boundAccount: string | undefined,
  tokenAccount: string | undefined,
): boolean {
  return Boolean(boundAccount && tokenAccount && boundAccount !== tokenAccount);
}

import { randomBytes } from 'node:crypto';

/**
 * Sign-In-With-Hedera nonce challenges.
 *
 * Single-use, short-TTL, and bound to the domain + issued-at that appear in the
 * signed text, so a captured signature cannot be replayed against this or any
 * other origin. Deliberately in-memory: a nonce outlives neither the browser
 * ceremony that created it nor a restart.
 */

export interface NonceRecord {
  nonce: string;
  domain: string;
  issuedAt: string;
  expiresAt: number;
}

export class NonceRegistry {
  private readonly nonces = new Map<string, NonceRecord>();

  constructor(private readonly ttlMs: number) {}

  issue(domain: string, now: number = Date.now()): NonceRecord {
    const record: NonceRecord = {
      nonce: randomBytes(16).toString('hex'),
      domain,
      issuedAt: new Date(now).toISOString(),
      expiresAt: now + this.ttlMs,
    };
    this.nonces.set(record.nonce, record);
    return record;
  }

  /**
   * Returns the record and removes it, so a second attempt with the same nonce fails.
   * Returns undefined for unknown, already-used, or expired nonces.
   */
  consume(nonce: string, now: number = Date.now()): NonceRecord | undefined {
    const record = this.nonces.get(nonce);
    if (!record) return undefined;
    this.nonces.delete(nonce);
    if (record.expiresAt <= now) return undefined;
    return record;
  }

  /** Drops expired entries so an abandoned-ceremony stream cannot grow the map without bound. */
  prune(now: number = Date.now()): void {
    for (const [nonce, record] of this.nonces) {
      if (record.expiresAt <= now) this.nonces.delete(nonce);
    }
  }

  get size(): number {
    return this.nonces.size;
  }
}

/**
 * The exact text the wallet displays and signs. CAIP-122 shaped: the account, the
 * origin requesting sign-in, and the nonce are all visible to the user, and every
 * one of them is bound into the signature.
 */
export function buildSignInMessage(params: {
  domain: string;
  accountId: string;
  uri: string;
  chainId: string;
  nonce: string;
  issuedAt: string;
}): string {
  return [
    `${params.domain} wants you to sign in with your Hedera account:`,
    params.accountId,
    '',
    'Sign in to authorize this MCP server to request transaction approvals.',
    'This signature does not move any funds and does not approve any transaction.',
    '',
    `URI: ${params.uri}`,
    'Version: 1',
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
  ].join('\n');
}

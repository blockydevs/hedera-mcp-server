import { createHash, randomBytes } from 'node:crypto';
import { type DataSource, In, LessThanOrEqual, type Repository } from 'typeorm';
import { GrantEntity } from '../database/entities/grant.entity.js';
import { PairingEntity } from '../database/entities/pairing.entity.js';
import { AuthCodeEntity } from '../database/entities/auth-code.entity.js';
import { OAuthClientEntity } from '../database/entities/oauth-client.entity.js';

/**
 * Durable state for the wallet-signing path, backed by TypeORM (Postgres in production,
 * sqlite in tests). Keeps token + pairing state coherent so a restart does not orphan
 * grants against WalletConnect's own restored sessions.
 *
 * Tokens and authorization codes are stored as SHA-256 hashes: a leaked database cannot be
 * replayed as a bearer token. Pending signing requests are deliberately NOT stored — they
 * are short-lived and hold transaction bytes.
 */

export interface Pairing {
  pairingRef: string;
  /** WalletConnect session topic — the routing key for delivering sign requests. */
  topic: string;
  accountId: string;
  network: string;
  createdAt: number;
  expiresAt: number;
}

export interface Grant {
  clientId: string;
  pairingRef: string;
  accountId: string;
  expiresAt: number;
  /** Present on refresh-token records only. */
  isRefresh?: boolean;
  scopes: string[];
}

export interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  pairingRef: string;
  accountId: string;
  expiresAt: number;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export class SessionStore {
  private readonly grants: Repository<GrantEntity>;
  private readonly pairings: Repository<PairingEntity>;
  private readonly codes: Repository<AuthCodeEntity>;
  private readonly clients: Repository<OAuthClientEntity>;
  /** Hashes of authorization codes already claimed, guarding against concurrent redemption. */
  private readonly claimedCodes = new Map<string, number>();

  constructor(private readonly dataSource: DataSource) {
    this.grants = dataSource.getRepository(GrantEntity);
    this.pairings = dataSource.getRepository(PairingEntity);
    this.codes = dataSource.getRepository(AuthCodeEntity);
    this.clients = dataSource.getRepository(OAuthClientEntity);
  }

  // --- pairings -------------------------------------------------------------

  async putPairing(pairing: Pairing): Promise<void> {
    await this.pairings.save(this.pairings.create(pairing));
  }

  async getPairing(pairingRef: string): Promise<Pairing | undefined> {
    const row = await this.pairings.findOneBy({ pairingRef });
    if (!row) return undefined;
    if (row.expiresAt <= Date.now()) {
      await this.deletePairing(pairingRef);
      return undefined;
    }
    return { ...row };
  }

  async deletePairing(pairingRef: string): Promise<void> {
    await this.pairings.delete({ pairingRef });
  }

  /**
   * Purge every pairing on a topic plus the grants and pending auth codes that depend on it.
   * Called on wallet-side `session_delete` so a disconnected wallet immediately invalidates
   * its tokens. Auth codes are included so a disconnect also revokes codes still
   * in flight through the OAuth exchange, not just issued tokens — token minting re-checks the
   * pairing as a second gate, but the row should not outlive the session it references.
   *
   * All four statements run in one transaction, and the dependents are deleted before the
   * pairing they hang off. Otherwise a failure after the pairing delete committed would leave
   * tokens valid with nothing left to find them by: the next retry reads no pairing rows for
   * the topic, computes an empty ref list, and skips the dependent deletes forever — the
   * disconnected wallet's tokens would then survive until natural expiry.
   */
  async purgeByTopic(topic: string): Promise<string[]> {
    return this.dataSource.transaction(async manager => {
      const rows = await manager.getRepository(PairingEntity).findBy({ topic });
      const refs = rows.map(row => row.pairingRef);
      if (refs.length > 0) {
        await manager.getRepository(GrantEntity).delete({ pairingRef: In(refs) });
        await manager.getRepository(AuthCodeEntity).delete({ pairingRef: In(refs) });
        await manager.getRepository(PairingEntity).delete({ topic });
      }
      return refs;
    });
  }

  // --- grants (access + refresh tokens, stored hashed) ----------------------

  async putGrant(token: string, grant: Grant): Promise<void> {
    await this.grants.save(
      this.grants.create({ tokenHash: hashToken(token), isRefresh: false, ...grant }),
    );
  }

  async getGrant(token: string): Promise<Grant | undefined> {
    const tokenHash = hashToken(token);
    const row = await this.grants.findOneBy({ tokenHash });
    if (!row) return undefined;
    if (row.expiresAt <= Date.now()) {
      await this.grants.delete({ tokenHash });
      return undefined;
    }
    return {
      clientId: row.clientId,
      pairingRef: row.pairingRef,
      accountId: row.accountId,
      expiresAt: row.expiresAt,
      isRefresh: row.isRefresh,
      scopes: row.scopes,
    };
  }

  async deleteGrant(token: string): Promise<void> {
    await this.grants.delete({ tokenHash: hashToken(token) });
  }

  // --- authorization codes (single-use) ------------------------------------

  async putAuthCode(code: string, record: AuthCode): Promise<void> {
    await this.codes.save(this.codes.create({ codeHash: hashToken(code), ...record }));
  }

  /**
   * Reads and removes the code — authorization codes are single-use.
   *
   * A synchronous in-memory claim (`has`/`set` before any `await`) closes the read-then-delete
   * TOCTOU window against concurrent redemption within this process. Across processes the
   * DELETE count below is the guarantee: Postgres serializes concurrent DELETEs of the same
   * row, so exactly one caller ever sees `affected === 1`. (`DELETE … RETURNING` would merge
   * the read and delete into one round trip, but adds no correctness.)
   */
  async consumeAuthCode(code: string): Promise<AuthCode | undefined> {
    const codeHash = hashToken(code);
    if (this.claimedCodes.has(codeHash)) return undefined;
    this.claimedCodes.set(codeHash, Date.now());

    const row = await this.codes.findOneBy({ codeHash });
    if (!row) return undefined;
    // Check the delete count: across instances two processes can both read the row, but only
    // one DELETE affects a row — the loser gets 0 and must not redeem the code.
    const result = await this.codes.delete({ codeHash });
    if (result.affected !== 1) return undefined;
    if (row.expiresAt <= Date.now()) return undefined;
    return this.toAuthCode(row);
  }

  async peekAuthCode(code: string): Promise<AuthCode | undefined> {
    const row = await this.codes.findOneBy({ codeHash: hashToken(code) });
    return row && row.expiresAt > Date.now() ? this.toAuthCode(row) : undefined;
  }

  private toAuthCode(row: AuthCodeEntity): AuthCode {
    return {
      clientId: row.clientId,
      redirectUri: row.redirectUri,
      codeChallenge: row.codeChallenge,
      pairingRef: row.pairingRef,
      accountId: row.accountId,
      expiresAt: row.expiresAt,
    };
  }

  // --- registered OAuth clients --------------------------------------------

  async putClient(clientId: string, client: Record<string, unknown>): Promise<void> {
    // Track issue time (ms) for the prune sweep; DCR clients carry client_id_issued_at (secs).
    const issuedSecs = Number(client.client_id_issued_at) || Math.floor(Date.now() / 1000);
    await this.clients.save(this.clients.create({ clientId, data: client, issuedAt: issuedSecs * 1000 }));
  }

  async getClient<T>(clientId: string): Promise<T | undefined> {
    const row = await this.clients.findOneBy({ clientId });
    return (row?.data as T | undefined) ?? undefined;
  }

  // --- garbage collection ---------------------------------------------------

  /**
   * Removes expired records with indexed deletes. Runs on the same interval as the in-memory
   * prunes. Aged (unauthenticated-registration) clients are swept by `issuedAt` so they
   * cannot accumulate unbounded.
   */
  async prune(now: number = Date.now(), clientTtlMs: number = 30 * 24 * 60 * 60 * 1000): Promise<void> {
    await this.grants.delete({ expiresAt: LessThanOrEqual(now) });
    await this.pairings.delete({ expiresAt: LessThanOrEqual(now) });
    await this.codes.delete({ expiresAt: LessThanOrEqual(now) });
    await this.clients.delete({ issuedAt: LessThanOrEqual(now - clientTtlMs) });

    for (const [hash, claimedAt] of this.claimedCodes) {
      if (claimedAt + 10 * 60 * 1000 <= now) this.claimedCodes.delete(hash);
    }
  }
}

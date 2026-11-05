import type { DataSource, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';
import { WcKvEntity } from '../database/entities/wc-kv.entity.js';
import { encrypt, decrypt } from '../crypto/envelope.js';

/**
 * WalletConnect's `IKeyValueStorage`, backed by the `wc_kv` Postgres table.
 *
 * WalletConnect's `SignClient`/`Core` accept a `storage` implementing this 5-method
 * interface; by handing it this instead of the default file store, WC's sessions persist to
 * the same database as our grants and survive a restart. The interface is matched
 * structurally (not `implements`) to avoid importing the type from the bundled package.
 *
 * When an encryption key is supplied, each value is envelope-encrypted at rest —
 * the row stores `{ enc: "<ciphertext>" }` instead of the raw value, so a leaked database does
 * not expose the WalletConnect relay symmetric keys. Reads transparently decrypt; rows written
 * before encryption was enabled (raw values, or ciphertext when the key is later removed) are
 * passed through, so toggling the key is backward-compatible.
 */

interface EncryptedRow {
  enc: string;
}

function isEncryptedRow(value: unknown): value is EncryptedRow {
  return typeof value === 'object' && value !== null && typeof (value as EncryptedRow).enc === 'string';
}

export class PgKvStorage {
  private readonly repo: Repository<WcKvEntity>;

  constructor(
    dataSource: DataSource,
    private readonly encryptionKey?: Buffer,
  ) {
    this.repo = dataSource.getRepository(WcKvEntity);
  }

  private encode<T>(value: T): unknown {
    if (!this.encryptionKey) return value;
    return { enc: encrypt(JSON.stringify(value), this.encryptionKey) };
  }

  private decode<T>(stored: unknown): T {
    if (isEncryptedRow(stored)) {
      if (!this.encryptionKey) {
        throw new Error('wc_kv row is encrypted but WC_ENCRYPTION_KEY is not set');
      }
      return JSON.parse(decrypt(stored.enc, this.encryptionKey)) as T;
    }
    return stored as T; // plaintext row (written before encryption was enabled)
  }

  async getKeys(): Promise<string[]> {
    const rows = await this.repo.find({ select: ['key'] });
    return rows.map(row => row.key);
  }

  async getEntries<T = unknown>(): Promise<[string, T][]> {
    const rows = await this.repo.find();
    return rows.map(row => [row.key, this.decode<T>(row.value)]);
  }

  async getItem<T = unknown>(key: string): Promise<T | undefined> {
    const row = await this.repo.findOneBy({ key });
    return row ? this.decode<T>(row.value) : undefined;
  }

  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    // upsert (ON CONFLICT) rather than save()'s read-then-write, so concurrent WalletConnect
    // writes to the same key can't race into a duplicate-key error or a lost update.
    // `value` is intentionally `unknown` (arbitrary WC JSON); cast to the upsert's partial-entity
    // shape rather than widening the column type.
    await this.repo.upsert({ key, value: this.encode(value) } as QueryDeepPartialEntity<WcKvEntity>, ['key']);
  }

  async removeItem(key: string): Promise<void> {
    await this.repo.delete({ key });
  }
}

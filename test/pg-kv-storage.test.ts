import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { PgKvStorage } from '../src/wallet/pg-kv-storage.js';
import { createTestDataSource } from './db.js';

let dataSource: DataSource;
let store: PgKvStorage;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  store = new PgKvStorage(dataSource);
});

afterEach(async () => {
  await dataSource.destroy();
});

// This is WalletConnect's storage backend — the 5 methods SignClient/Core drive.
describe('PgKvStorage (WalletConnect IKeyValueStorage)', () => {
  it('round-trips a JSON value', async () => {
    await store.setItem('session:abc', { topic: 'abc', symKey: 'deadbeef', n: 1 });
    expect(await store.getItem('session:abc')).toEqual({ topic: 'abc', symKey: 'deadbeef', n: 1 });
  });

  it('returns undefined for a missing key', async () => {
    expect(await store.getItem('nope')).toBeUndefined();
  });

  it('overwrites on repeated setItem', async () => {
    await store.setItem('k', { v: 1 });
    await store.setItem('k', { v: 2 });
    expect(await store.getItem('k')).toEqual({ v: 2 });
  });

  it('lists keys and entries', async () => {
    await store.setItem('a', 1);
    await store.setItem('b', 2);
    expect((await store.getKeys()).sort()).toEqual(['a', 'b']);
    expect((await store.getEntries()).sort()).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('removes an item', async () => {
    await store.setItem('gone', true);
    await store.removeItem('gone');
    expect(await store.getItem('gone')).toBeUndefined();
    expect(await store.getKeys()).not.toContain('gone');
  });
});

describe('PgKvStorage concurrent writes (upsert)', () => {
  it('does not throw a duplicate-key error on racing writes to one key', async () => {
    await Promise.all([
      store.setItem('race', { v: 1 }),
      store.setItem('race', { v: 2 }),
      store.setItem('race', { v: 3 }),
    ]);
    // Exactly one row, last-writer-wins — no duplicate-key throw.
    expect((await store.getKeys()).filter(k => k === 'race')).toHaveLength(1);
    expect(await store.getItem('race')).toBeTruthy();
  });
});

import { deriveEncryptionKey } from '../src/crypto/envelope.js';

describe('PgKvStorage with encryption at rest', () => {
  it('stores ciphertext on disk but returns plaintext to WalletConnect', async () => {
    const encKey = deriveEncryptionKey('test-key');
    const encStore = new PgKvStorage(dataSource, encKey);
    await encStore.setItem('wc@2:core:0.3//keychain', { '0.0.x': 'symKey-secret-value' });

    // Round-trips for the caller...
    expect(await encStore.getItem('wc@2:core:0.3//keychain')).toEqual({ '0.0.x': 'symKey-secret-value' });

    // ...but the raw row is an { enc } envelope, not the plaintext secret.
    const raw: any = await dataSource.getRepository(
      (await import('../src/database/entities/wc-kv.entity.js')).WcKvEntity,
    ).findOneBy({ key: 'wc@2:core:0.3//keychain' });
    expect(raw.value).toHaveProperty('enc');
    expect(JSON.stringify(raw.value)).not.toContain('symKey-secret-value');
  });

  it('reads back plaintext rows written before encryption was enabled', async () => {
    await store.setItem('legacy', { plain: true });                 // plaintext (no key)
    const encStore = new PgKvStorage(dataSource, deriveEncryptionKey('test-key'));
    expect(await encStore.getItem('legacy')).toEqual({ plain: true }); // still readable
  });
});

describe('PgKvStorage fail-closed when a key is removed', () => {
  it('throws if a row is encrypted but no key is configured', async () => {
    const encStore = new PgKvStorage(dataSource, deriveEncryptionKey('k'));
    await encStore.setItem('secret', { symKey: 'x' });
    const plainStore = new PgKvStorage(dataSource); // no key
    await expect(plainStore.getItem('secret')).rejects.toThrow(/encrypted but/);
  });
});

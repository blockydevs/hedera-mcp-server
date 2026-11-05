import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { SessionStore, hashToken, newToken, type Pairing } from '../src/store/session-store.js';
import { createTestDataSource } from './db.js';

let dataSource: DataSource;
let store: SessionStore;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  store = new SessionStore(dataSource);
});

afterEach(async () => {
  await dataSource.destroy();
});

function pairing(overrides: Partial<Pairing> = {}): Pairing {
  return {
    pairingRef: 'pair-1',
    topic: 'topic-a',
    accountId: '0.0.1001',
    network: 'testnet',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe('token hashing', () => {
  // A leaked store must not be replayable as a bearer token.
  it('never stores the raw token', async () => {
    const token = newToken();
    await store.putGrant(token, {
      clientId: 'c1', pairingRef: 'pair-1', accountId: '0.0.1001',
      expiresAt: Date.now() + 60_000, scopes: ['hedera:sign'],
    });
    expect(hashToken(token)).not.toBe(token);
    expect(hashToken(token)).toHaveLength(64);
  });

  it('hashes deterministically so lookups work', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
});

describe('pairings', () => {
  it('round-trips a pairing', async () => {
    await store.putPairing(pairing());
    expect((await store.getPairing('pair-1'))?.accountId).toBe('0.0.1001');
  });

  it('is visible to a new store instance over the same database', async () => {
    await store.putPairing(pairing());
    expect(await new SessionStore(dataSource).getPairing('pair-1')).toBeDefined();
  });

  it('treats an expired pairing as absent', async () => {
    await store.putPairing(pairing({ expiresAt: Date.now() - 1 }));
    expect(await store.getPairing('pair-1')).toBeUndefined();
  });
});

describe('grants', () => {
  it('round-trips a grant by token', async () => {
    const token = newToken();
    await store.putGrant(token, {
      clientId: 'c1', pairingRef: 'pair-1', accountId: '0.0.1001',
      expiresAt: Date.now() + 60_000, scopes: ['hedera:sign'],
    });
    expect((await store.getGrant(token))?.accountId).toBe('0.0.1001');
  });

  it('treats an expired grant as absent', async () => {
    const token = newToken();
    await store.putGrant(token, {
      clientId: 'c1', pairingRef: 'pair-1', accountId: '0.0.1001',
      expiresAt: Date.now() - 1, scopes: ['hedera:sign'],
    });
    expect(await store.getGrant(token)).toBeUndefined();
  });

  it('returns nothing for a token that was never issued', async () => {
    expect(await store.getGrant(newToken())).toBeUndefined();
  });
});

describe('authorization codes', () => {
  const record = {
    clientId: 'c1', redirectUri: 'https://client.example/cb',
    codeChallenge: 'challenge', pairingRef: 'pair-1',
    accountId: '0.0.1001', expiresAt: Date.now() + 60_000,
  };

  it('can be peeked without being spent, so PKCE can be checked first', async () => {
    const code = newToken();
    await store.putAuthCode(code, record);
    expect(await store.peekAuthCode(code)).toBeDefined();
    expect(await store.peekAuthCode(code)).toBeDefined();
  });

  // Single-use is what stops a stolen code being exchanged twice.
  it('consumes exactly once', async () => {
    const code = newToken();
    await store.putAuthCode(code, record);
    expect(await store.consumeAuthCode(code)).toBeDefined();
    expect(await store.consumeAuthCode(code)).toBeUndefined();
  });

  it('refuses an expired code but still spends it', async () => {
    const code = newToken();
    await store.putAuthCode(code, { ...record, expiresAt: Date.now() - 1 });
    expect(await store.consumeAuthCode(code)).toBeUndefined();
  });
});

describe('purgeByTopic', () => {
  // A wallet disconnect must invalidate the tokens riding on that session immediately,
  // not merely cause a later failure.
  it('removes the pairing and its dependent grants', async () => {
    const token = newToken();
    await store.putPairing(pairing());
    await store.putGrant(token, {
      clientId: 'c1', pairingRef: 'pair-1', accountId: '0.0.1001',
      expiresAt: Date.now() + 60_000, scopes: ['hedera:sign'],
    });

    expect(await store.purgeByTopic('topic-a')).toEqual(['pair-1']);
    expect(await store.getPairing('pair-1')).toBeUndefined();
    expect(await store.getGrant(token)).toBeUndefined();
  });

  // A disconnect must also revoke a code still in flight through the OAuth exchange, not
  // just issued tokens.
  it('removes unredeemed auth codes on the purged pairing', async () => {
    const code = newToken();
    await store.putPairing(pairing());
    await store.putAuthCode(code, {
      clientId: 'c1', redirectUri: 'https://client.example/cb', codeChallenge: 'ch',
      pairingRef: 'pair-1', accountId: '0.0.1001', expiresAt: Date.now() + 60_000,
    });

    await store.purgeByTopic('topic-a');
    expect(await store.peekAuthCode(code)).toBeUndefined();
  });

  it('leaves other sessions alone', async () => {
    const keep = newToken();
    const keepCode = newToken();
    await store.putPairing(pairing());
    await store.putPairing(pairing({ pairingRef: 'pair-2', topic: 'topic-b', accountId: '0.0.2002' }));
    await store.putGrant(keep, {
      clientId: 'c1', pairingRef: 'pair-2', accountId: '0.0.2002',
      expiresAt: Date.now() + 60_000, scopes: ['hedera:sign'],
    });
    await store.putAuthCode(keepCode, {
      clientId: 'c1', redirectUri: 'https://client.example/cb', codeChallenge: 'ch',
      pairingRef: 'pair-2', accountId: '0.0.2002', expiresAt: Date.now() + 60_000,
    });

    await store.purgeByTopic('topic-a');
    expect(await store.getPairing('pair-2')).toBeDefined();
    expect(await store.getGrant(keep)).toBeDefined();
    expect(await store.peekAuthCode(keepCode)).toBeDefined();
  });
});

describe('authorization code — concurrent redemption (L4 TOCTOU)', () => {
  it('lets only one of two concurrent consumers win', async () => {
    const code = newToken();
    await store.putAuthCode(code, {
      clientId: 'c1', redirectUri: 'https://client.example/cb', codeChallenge: 'ch',
      pairingRef: 'pair-1', accountId: '0.0.1001', expiresAt: Date.now() + 60_000,
    });
    const [a, b] = await Promise.all([store.consumeAuthCode(code), store.consumeAuthCode(code)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

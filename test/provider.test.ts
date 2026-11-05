import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { LedgerId } from '@hiero-ledger/sdk';
import { WalletOAuthProvider, WALLET_SCOPE } from '../src/auth/provider.js';
import { SessionStore } from '../src/store/session-store.js';
import type { WalletApprover } from '../src/wallet/approver.js';
import { createTestDataSource } from './db.js';

/**
 * Covers the token lifecycle the wallet ceremony hands off to: code exchange, access-token
 * verification, the "never outlive the wallet session" cap, refresh rotation, and revocation.
 * The signature-verification half of the ceremony needs a live wallet + mirror node and is
 * covered by the manual testnet run, not here.
 */

const CLIENT = { client_id: 'client-1', redirect_uris: ['https://client.example/cb'] } as any;
const DAY = 24 * 60 * 60 * 1000;

let dataSource: DataSource;
let store: SessionStore;
let provider: WalletOAuthProvider;
let sessionAlive: boolean;

function fakeApprover(): WalletApprover {
  return {
    hasSession: () => sessionAlive,
    disconnect: async () => {},
  } as unknown as WalletApprover;
}

async function seed(pairingExpiresAt: number): Promise<void> {
  await store.putClient('client-1', { ...CLIENT });
  await store.putPairing({
    pairingRef: 'pair-1',
    topic: 'topic-a',
    accountId: '0.0.1001',
    network: 'testnet',
    createdAt: Date.now(),
    expiresAt: pairingExpiresAt,
  });
  await store.putAuthCode('code-1', {
    clientId: 'client-1',
    redirectUri: 'https://client.example/cb',
    codeChallenge: 'the-challenge',
    pairingRef: 'pair-1',
    accountId: '0.0.1001',
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
}

beforeEach(async () => {
  dataSource = await createTestDataSource();
  store = new SessionStore(dataSource);
  provider = new WalletOAuthProvider(store, fakeApprover(), LedgerId.TESTNET);
  sessionAlive = true;
});

afterEach(async () => {
  await dataSource.destroy();
});

describe('authorization code exchange', () => {
  it('exposes the PKCE challenge recorded with the code', async () => {
    await seed(Date.now() + 7 * DAY);
    expect(await provider.challengeForAuthorizationCode(CLIENT, 'code-1')).toBe('the-challenge');
  });

  it('exchanges a code for a bearer + refresh token scoped to signing', async () => {
    await seed(Date.now() + 7 * DAY);
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, 'code-1');
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.scope).toBe(WALLET_SCOPE);
  });

  it('refuses to exchange the same code twice', async () => {
    await seed(Date.now() + 7 * DAY);
    await provider.exchangeAuthorizationCode(CLIENT, 'code-1');
    await expect(provider.exchangeAuthorizationCode(CLIENT, 'code-1')).rejects.toThrow();
  });

  it('refuses a code issued to a different client', async () => {
    await seed(Date.now() + 7 * DAY);
    await expect(
      provider.exchangeAuthorizationCode({ client_id: 'someone-else' } as any, 'code-1'),
    ).rejects.toThrow();
  });
});

describe('access token verification', () => {
  it('resolves the subject to the proven Hedera account', async () => {
    await seed(Date.now() + 7 * DAY);
    const { access_token } = await provider.exchangeAuthorizationCode(CLIENT, 'code-1');
    const info = await provider.verifyAccessToken(access_token);
    expect(info.extra?.accountId).toBe('0.0.1001');
    expect(info.extra?.topic).toBe('topic-a');
    expect(info.scopes).toContain(WALLET_SCOPE);
  });

  it('reports the WC session expiry (not the token expiry) for wallet_status', async () => {
    const pairingExpiry = Date.now() + 7 * DAY;
    await seed(pairingExpiry);
    const { access_token } = await provider.exchangeAuthorizationCode(CLIENT, 'code-1');
    const info = await provider.verifyAccessToken(access_token);
    expect(info.extra?.sessionExpiry).toBe(pairingExpiry);
  });

  it('rejects a refresh token used as an access token', async () => {
    await seed(Date.now() + 7 * DAY);
    const { refresh_token } = await provider.exchangeAuthorizationCode(CLIENT, 'code-1');
    await expect(provider.verifyAccessToken(refresh_token!)).rejects.toThrow();
  });
});

describe('token lifetime never exceeds the wallet session', () => {
  it('caps the access token at the pairing expiry when it is sooner', async () => {
    const pairingExpiry = Date.now() + 30 * 60 * 1000; // 30 min, under the 1h access default
    await seed(pairingExpiry);
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, 'code-1');
    expect(tokens.expires_in).toBeLessThanOrEqual(30 * 60);
  });
});

describe('refresh token', () => {
  it('rotates to a fresh access token while the session is alive', async () => {
    await seed(Date.now() + 7 * DAY);
    const first = await provider.exchangeAuthorizationCode(CLIENT, 'code-1');
    const refreshed = await provider.exchangeRefreshToken(CLIENT, first.refresh_token!);
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(first.access_token);
  });

  it('fails once the wallet session has ended', async () => {
    await seed(Date.now() + 7 * DAY);
    const first = await provider.exchangeAuthorizationCode(CLIENT, 'code-1');
    sessionAlive = false;
    await expect(provider.exchangeRefreshToken(CLIENT, first.refresh_token!)).rejects.toThrow();
  });
});

describe('revocation', () => {
  it('invalidates the token and tears down its pairing (they are 1:1)', async () => {
    await seed(Date.now() + 7 * DAY);
    const { access_token } = await provider.exchangeAuthorizationCode(CLIENT, 'code-1');
    await provider.revokeToken(CLIENT, { token: access_token });
    await expect(provider.verifyAccessToken(access_token)).rejects.toThrow();
    expect(await store.getPairing('pair-1')).toBeUndefined();
  });
});

describe('ceremony pruning', () => {
  it('drops an expired sign-in ceremony', async () => {
    let redirectedTo = '';
    const res = { redirect: (url: string) => { redirectedTo = url; } } as any;
    await provider.authorize(CLIENT, {
      redirectUri: 'https://client.example/cb',
      codeChallenge: 'c',
      state: 's',
      scopes: [WALLET_SCOPE],
    }, res);

    const ceremonyId = new URLSearchParams(redirectedTo.split('?')[1]).get('ceremony')!;
    expect(provider.getCeremony(ceremonyId)).toBeDefined();

    provider.prune(Date.now() + 60 * 60 * 1000); // an hour on, well past the 5-min ceremony TTL
    expect(provider.getCeremony(ceremonyId)).toBeUndefined();
  });
});

describe('dangling-session cleanup', () => {
  const SESSION = {
    topic: 'topic-x',
    namespaces: { hedera: { accounts: ['hedera:testnet:0.0.1001'] } },
    expiry: Math.floor(Date.now() / 1000) + 7 * DAY / 1000,
  };

  /** An approver that pairs successfully but whose sign-in step the test controls. */
  function ceremonyApprover(signMessage: () => Promise<string>) {
    const disconnected: string[] = [];
    const approver = {
      startPairing: async () => ({ uri: 'wc:test', approval: Promise.resolve(SESSION) }),
      signMessage,
      disconnect: async (topic: string) => { disconnected.push(topic); },
      hasSession: () => true,
    } as unknown as WalletApprover;
    return { approver, disconnected };
  }

  async function startCeremony(p: WalletOAuthProvider): Promise<string> {
    let redirectedTo = '';
    const res = { redirect: (url: string) => { redirectedTo = url; } } as any;
    await p.authorize(CLIENT, {
      redirectUri: 'https://client.example/cb', codeChallenge: 'c', state: 's', scopes: [WALLET_SCOPE],
    }, res);
    const id = new URLSearchParams(redirectedTo.split('?')[1]).get('ceremony')!;
    await p.runCeremony(id);
    return id;
  }

  async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
    const start = Date.now();
    while (!cond() && Date.now() - start < ms) await new Promise(r => setTimeout(r, 5));
  }

  // The point of the fix: a pairing that never completes login is torn down, not left open.
  it('disconnects the pairing when sign-in fails', async () => {
    const { approver, disconnected } = ceremonyApprover(async () => {
      throw new Error('user rejected the sign-in message');
    });
    const p = new WalletOAuthProvider(store, approver, LedgerId.TESTNET);
    const id = await startCeremony(p);
    await waitFor(() => p.getCeremony(id)?.status === 'failed');
    expect(disconnected).toContain('topic-x');
  });

  it('disconnects an abandoned pairing on prune', async () => {
    // Sign-in never resolves — the user walked away after pairing.
    const { approver, disconnected } = ceremonyApprover(() => new Promise<string>(() => {}));
    const p = new WalletOAuthProvider(store, approver, LedgerId.TESTNET);
    const id = await startCeremony(p);
    await waitFor(() => p.getCeremony(id)?.topic === 'topic-x'); // reached awaiting_signature
    p.prune(Date.now() + 60 * 60 * 1000);
    expect(disconnected).toContain('topic-x');
    expect(p.getCeremony(id)).toBeUndefined();
  });
});

describe('redirect_uri binding + refresh reuse (L5, T5)', () => {
  it('rejects a token exchange whose redirect_uri does not match the authorization request', async () => {
    await seed(Date.now() + 7 * DAY);
    await expect(
      provider.exchangeAuthorizationCode(CLIENT, 'code-1', undefined, 'https://evil.example/cb'),
    ).rejects.toThrow();
  });

  it('accepts the matching redirect_uri', async () => {
    await seed(Date.now() + 7 * DAY);
    const tokens = await provider.exchangeAuthorizationCode(
      CLIENT, 'code-1', undefined, 'https://client.example/cb',
    );
    expect(tokens.access_token).toBeTruthy();
  });

  it('kills the old refresh token after a rotation (no replay)', async () => {
    await seed(Date.now() + 7 * DAY);
    const first = await provider.exchangeAuthorizationCode(CLIENT, 'code-1');
    await provider.exchangeRefreshToken(CLIENT, first.refresh_token!);
    await expect(provider.exchangeRefreshToken(CLIENT, first.refresh_token!)).rejects.toThrow();
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Route-level coverage for the sign-in page.
 *
 * Exercises `createConnectRouter` directly -- `connect.test.ts` unit-tests `originAllowed` only,
 * and `origin-auth-coverage.test.ts` just checks the paths sit behind the HMAC gate. This covers
 * the security headers, the ceremony lookup and the `stringQuery` guard on the one route that
 * hands out OAuth authorization codes.
 *
 * `walletConfig` reads its env at module load, so the import is dynamic and follows the setup.
 */

const PUBLIC_URL = 'https://mcp.example.com';
const LIVE = 'live-ceremony-id';

let app: express.Express;

/** Enough of WalletOAuthProvider for the router; no relay, no database, no wallet. */
const provider = {
  getCeremony: (id: string) =>
    id === LIVE
      ? {
          ceremonyId: LIVE,
          status: 'awaiting_signature',
          accountId: '0.0.4536372',
          redirectTo: 'https://client.example/cb?code=abc',
        }
      : undefined,
  runCeremony: async (id: string) => {
    if (id !== LIVE) throw new Error('Unknown sign-in ceremony');
    return {
      ceremonyId: LIVE,
      status: 'pairing',
      uri: 'wc:abc@2?relay-protocol=irn&symKey=def',
    };
  },
};

beforeAll(async () => {
  process.env.WALLETCONNECT_PROJECT_ID = '0'.repeat(32);
  process.env.PUBLIC_URL = PUBLIC_URL;
  process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused';
  process.env.WC_ENCRYPTION_KEY = 'x'.repeat(32);

  const { createConnectRouter } = await import('../src/web/connect.js');
  app = express();
  app.use(express.json());
  app.use(createConnectRouter(provider as never));
});

afterAll(() => {
  for (const k of ['WALLETCONNECT_PROJECT_ID', 'PUBLIC_URL', 'DATABASE_URL', 'WC_ENCRYPTION_KEY']) {
    delete process.env[k];
  }
});

describe('GET /connect', () => {
  it('serves the page for a live ceremony, with its security headers', async () => {
    const res = await request(app).get('/connect').query({ ceremony: LIVE });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('Hedera Network MCP');
  });

  it('sends a CSP whose nonce matches the tags it served', async () => {
    const res = await request(app).get('/connect').query({ ceremony: LIVE });
    const csp = res.headers['content-security-policy'];

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");

    // A nonce that does not match the markup means the page ships with its own script blocked.
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    for (const tag of res.text.match(/<(?:script|style)\b[^>]*>/g) ?? []) {
      expect(tag).toContain(`nonce="${nonce!}"`);
    }
  });

  it('gives every response a fresh nonce', async () => {
    const nonceOf = (csp: string) => /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    const a = await request(app).get('/connect').query({ ceremony: LIVE });
    const b = await request(app).get('/connect').query({ ceremony: LIVE });
    expect(nonceOf(a.headers['content-security-policy'])).not.toBe(
      nonceOf(b.headers['content-security-policy']),
    );
  });

  it('answers an unknown ceremony with the styled expired page, not bare text', async () => {
    const res = await request(app).get('/connect').query({ ceremony: 'nope' });

    expect(res.status).toBe(404);
    // Deliberately changed from text/plain; pinned so it is not reverted by accident.
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('expired');
  });

  it('refuses a structured ceremony parameter', async () => {
    // Express turns ?ceremony[x]=y into an object; String() on it yields '[object Object]', a key
    // that was never sent. stringQuery is the guard and had no test.
    const res = await request(app).get('/connect?ceremony[x]=y');
    expect(res.status).toBe(404);
  });
});

describe('POST /connect/start', () => {
  it('refuses a cross-origin caller', async () => {
    const res = await request(app)
      .post('/connect/start')
      .set('Origin', 'https://evil.example')
      .send({ ceremony: LIVE });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cross-origin/i);
  });

  it('starts the pairing for a same-origin caller and returns a QR', async () => {
    const res = await request(app)
      .post('/connect/start')
      .set('Origin', PUBLIC_URL)
      .send({ ceremony: LIVE });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pairing');
    expect(res.body.uri).toMatch(/^wc:/);
    // The client only accepts a data:image/png; anything else silently renders no QR.
    expect(res.body.qr).toMatch(/^data:image\/png;base64,/);
  });

  it('reports a failed ceremony as a 400', async () => {
    const res = await request(app)
      .post('/connect/start')
      .set('Origin', PUBLIC_URL)
      .send({ ceremony: 'nope' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unknown sign-in ceremony');
  });
});

describe('GET /connect/status', () => {
  it('returns the account id and withholds the redirect until complete', async () => {
    const res = await request(app).get('/connect/status').query({ ceremony: LIVE });

    expect(res.status).toBe(200);
    expect(res.body.accountId).toBe('0.0.4536372');
    // The redirect carries the authorization code, so it must not leak before sign-in finishes.
    expect(res.body.redirectTo).toBeUndefined();
  });

  it('404s a pruned ceremony, which is what drives the expired view', async () => {
    const res = await request(app).get('/connect/status').query({ ceremony: 'nope' });
    expect(res.status).toBe(404);
  });
});

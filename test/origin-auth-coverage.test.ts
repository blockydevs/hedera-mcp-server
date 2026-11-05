import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { LedgerId, Client } from '@hiero-ledger/sdk';

/**
 * Which endpoints the HMAC origin gate covers, in wallet mode.
 *
 * The gate must sit above the OAuth and connect routers. An Express router that handles a path
 * ends the chain, so mounting the gate below them silently leaves /authorize, /token, /register,
 * /.well-known/* and /connect reachable straight from the internet, bypassing the edge. That
 * regression passes every other test in this suite, so it is pinned here.
 *
 * Only the orchestrator probes are exempt: they hit the container directly, not via the edge.
 *
 * walletConfig reads its env at module load, so the imports are dynamic and follow the setup.
 */

const SECRET = 'edge-worker-secret';
const GUARDED = [
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/authorize',
  '/token',
  '/register',
  '/connect',
  '/connect/status',
  '/approve',
  '/mcp',
  '/some/unmatched/path',
];
const OPEN = ['/healthz', '/readyz'];

let dir: string;
let app: import('express').Express;
let handle: { close: () => Promise<void> };

/** Sign as the edge proxy does: method, path, timestamp, nonce, hash of the raw body. */
function signedHeaders(method: string, path: string, body = '') {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const bodyHash = createHash('sha256').update(Buffer.from(body)).digest('hex');
  const sig = createHmac('sha256', SECRET)
    .update([method, path, ts, nonce, bodyHash].join('\n'))
    .digest('hex');
  return { 'x-origin-timestamp': ts, 'x-origin-nonce': nonce, 'x-origin-signature': sig };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'origin-cov-'));
  const secretFile = join(dir, 'secret.txt');
  writeFileSync(secretFile, `${SECRET}\n`);
  process.env.ORIGIN_AUTH_VERIFICATION_ENABLED = 'true';
  process.env.ORIGIN_AUTH_SECRET_FILE_PATH = secretFile;
  // Turns on the wallet block, which mounts the OAuth and connect routers.
  process.env.WALLETCONNECT_PROJECT_ID = '0'.repeat(32);
  process.env.PUBLIC_URL = 'https://mcp.example.com';
  // Config fails closed without these in wallet mode. Nothing connects: dataSource is null.
  process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused';
  process.env.WC_ENCRYPTION_KEY = 'x'.repeat(32);

  const { createHttpApp } = await import('../src/server/http-app.js');
  const { configureMcpHttp } = await import('../src/server/configure.js');

  // Just enough shape to let the wallet block mount its routers; no request ever reaches them.
  const provider = {
    clientsStore: { getClient: async () => undefined },
    getCeremony: () => undefined,
    runCeremony: async () => undefined,
    prune: () => {},
    verifyAccessToken: async () => {
      throw new Error('no token');
    },
  };
  const noop = {
    onSessionGone: () => {},
    markSessionGone: () => {},
    prune: () => {},
    purgeByTopic: async () => [],
  };

  app = createHttpApp('localhost');
  handle = configureMcpHttp(app, {
    options: { ledgerId: LedgerId.TESTNET, context: {}, port: 0, host: 'localhost' },
    client: Client.forTestnet(),
    provider: provider as never,
    approver: noop as never,
    registry: noop as never,
    intents: noop as never,
    approvalHook: null,
    store: noop as never,
    dataSource: null,
  });
});

afterAll(async () => {
  await handle?.close();
  for (const k of [
    'ORIGIN_AUTH_VERIFICATION_ENABLED',
    'ORIGIN_AUTH_SECRET_FILE_PATH',
    'WALLETCONNECT_PROJECT_ID',
    'PUBLIC_URL',
    'DATABASE_URL',
    'WC_ENCRYPTION_KEY',
  ]) {
    delete process.env[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('HMAC gate coverage in wallet mode', () => {
  it.each(GUARDED)('rejects an unsigned request to %s', async path => {
    const res = await request(app).get(path);
    expect(res.status).toBe(401);
    // The gate's own rejection, not the OAuth bearer layer's (which sets WWW-Authenticate).
    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  it.each(OPEN)('leaves the orchestrator probe %s reachable', async path => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
  });

  // The discovery documents must stay usable once the edge signs them, or clients cannot
  // find the OAuth endpoints at all.
  it.each([
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource',
  ])('serves %s to a correctly signed request', async path => {
    const res = await request(app).get(path).set(signedHeaders('GET', path));
    expect(res.status).toBe(200);
  });

  // /token is form-encoded, which express.json() does not claim. While only JSON captured raw
  // bytes, the gate hashed an empty buffer and 401'd every real authorization-code exchange.
  it('lets a signed form-encoded /token exchange through to the OAuth handler', async () => {
    const body = 'grant_type=authorization_code&code=abc&client_id=nobody&code_verifier=xyz';
    const res = await request(app)
      .post('/token')
      .set(signedHeaders('POST', '/token', body))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(body);
    // A JSON error means OAuth answered; the gate's own rejection is plain 'Unauthorized'.
    expect(res.text).not.toBe('Unauthorized');
    expect(res.body.error).toBeTypeOf('string');
  });

  // Signed traffic to /mcp clears the gate and is then stopped by OAuth, not by the gate.
  it('lets a signed /mcp request through to the bearer-auth layer', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const res = await request(app)
      .post('/mcp')
      .set(signedHeaders('POST', '/mcp', body))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
  });
});

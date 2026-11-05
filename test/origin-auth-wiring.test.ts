import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { LedgerId, Client } from '@hiero-ledger/sdk';
import { createHttpApp } from '../src/server/http-app.js';
import { configureMcpHttp, type McpHttpHandle } from '../src/server/configure.js';


/**
 * Wiring test for the HMAC origin gate over the real assembled stack.
 *
 * The unit tests prove verifyOriginAuth's logic; this proves it is actually mounted and that
 * req.rawBody survives the NestJS-era Express setup. That is the failure the merge could have
 * shipped silently: the SDK's createMcpExpressApp parses JSON without retaining the raw bytes,
 * so the gate would reject every correctly signed request.
 */

const SECRET = 'edge-worker-secret';
const ACCEPT = 'application/json, text/event-stream';
const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};

let dir: string;
let app: ReturnType<typeof createHttpApp>;
let handle: McpHttpHandle;

function sign(method: string, path: string, ts: string, nonce: string, raw: string): string {
  const bodyHash = createHash('sha256').update(Buffer.from(raw)).digest('hex');
  return createHmac('sha256', SECRET).update([method, path, ts, nonce, bodyHash].join('\n')).digest('hex');
}

/** Headers an edge proxy would attach for this exact payload. */
function originHeaders(raw: string, path = '/mcp') {
  const ts = String(Date.now());
  const nonce = randomUUID();
  return {
    'x-origin-timestamp': ts,
    'x-origin-nonce': nonce,
    'x-origin-signature': sign('POST', path, ts, nonce, raw),
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'origin-auth-'));
  const secretFile = join(dir, 'secret.txt');
  writeFileSync(secretFile, `${SECRET}\n`);
  process.env.ORIGIN_AUTH_VERIFICATION_ENABLED = 'true';
  process.env.ORIGIN_AUTH_SECRET_FILE_PATH = secretFile;

  app = createHttpApp('localhost');
  handle = configureMcpHttp(app, {
    options: { ledgerId: LedgerId.TESTNET, context: {}, port: 0, host: 'localhost' },
    client: Client.forTestnet(),
    provider: null,
    approver: null,
    registry: null,
    intents: null,
    approvalHook: null,
    store: null,
    dataSource: null,
  });
});

afterAll(async () => {
  await handle.close();
  delete process.env.ORIGIN_AUTH_VERIFICATION_ENABLED;
  delete process.env.ORIGIN_AUTH_SECRET_FILE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe('HMAC origin gate, mounted', () => {
  it('lets a correctly signed request through to the MCP handler', async () => {
    const raw = JSON.stringify(INIT);
    const res = await request(app)
      .post('/mcp')
      .set(originHeaders(raw))
      .set('Accept', ACCEPT)
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });

  it('rejects an unsigned request with 401', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Accept', ACCEPT)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(INIT));
    expect(res.status).toBe(401);
  });

  // Proves the body hash is computed over the bytes actually received, not an empty buffer:
  // if rawBody were lost, signing one payload and sending another would wrongly succeed.
  it('rejects a request whose body was altered after signing', async () => {
    const headers = originHeaders(JSON.stringify(INIT));
    const res = await request(app)
      .post('/mcp')
      .set(headers)
      .set('Accept', ACCEPT)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ ...INIT, id: 99 }));
    expect(res.status).toBe(401);
  });

  it('rejects a replayed signature', async () => {
    const raw = JSON.stringify(INIT);
    const headers = originHeaders(raw);
    const send = () =>
      request(app)
        .post('/mcp')
        .set(headers)
        .set('Accept', ACCEPT)
        .set('Content-Type', 'application/json')
        .send(raw);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(401);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { brotliCompressSync, gzipSync, deflateSync } from 'node:zlib';
import request from 'supertest';
import type { Express } from 'express';
import { createHttpApp } from '../src/server/http-app.js';

/**
 * CVE-2026-111497 (Node2Shell): body-parser decompresses `Content-Encoding: br`, and it runs
 * above the HMAC gate, so any client that reaches the container could feed Brotli to zlib
 * unauthenticated. Compressed bodies must be refused before any parser or later route sees them.
 */

const BODY = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 });
const ENCODINGS = [
  ['br', brotliCompressSync],
  ['gzip', gzipSync],
  ['deflate', deflateSync],
] as const;

let app: Express;
let reached: boolean;

beforeAll(() => {
  app = createHttpApp('localhost');
  // Stands in for the HMAC gate and everything below it.
  app.use((_req, res) => {
    reached = true;
    res.status(401).json({ error: 'gate' });
  });
});

describe('compressed request bodies', () => {
  it.each(ENCODINGS.flatMap(([enc, zip]) => ['/mcp', '/token', '/connect'].map(path => [enc, zip, path] as const)))(
    'refuses Content-Encoding: %s on %s before the gate',
    async (encoding, compress, path) => {
      reached = false;
      const res = await request(app)
        .post(path)
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', encoding)
        .send(compress(Buffer.from(BODY)));
      expect(res.status).toBe(415);
      expect(reached).toBe(false);
    },
  );

  it('refuses an encoded body regardless of case or content type', async () => {
    reached = false;
    const res = await request(app)
      .post('/token')
      .set('Content-Type', 'text/plain')
      .set('Content-Encoding', ' BR ')
      .send(brotliCompressSync(Buffer.from('x')));
    expect(res.status).toBe(415);
    expect(reached).toBe(false);
  });

  it.each([undefined, 'identity'])('passes an uncompressed body (Content-Encoding: %s) on', async encoding => {
    reached = false;
    const req = request(app).post('/mcp').set('Content-Type', 'application/json');
    if (encoding) req.set('Content-Encoding', encoding);
    const res = await req.send(BODY);
    expect(res.status).toBe(401);
    expect(reached).toBe(true);
  });
});

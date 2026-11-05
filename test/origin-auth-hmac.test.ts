import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { verifyOriginAuth, isOriginAuthVerificationEnabled } from '../src/auth/origin-auth.js';

/**
 * Characterisation tests for the HMAC origin gate.
 *
 * They pin the wire contract an edge proxy signs against, so a refactor cannot silently
 * change it. Treat a failure here as a breaking change for deployed proxies, not a test to
 * update.
 */

const SECRET = 'shared-edge-secret';

function sign(
  method: string,
  path: string,
  ts: string,
  nonce: string,
  body: Buffer,
  secret = SECRET,
): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', secret).update([method, path, ts, nonce, bodyHash].join('\n')).digest('hex');
}

function req(headers: Record<string, unknown>, method = 'POST', path = '/mcp'): Request {
  return { headers, method, path } as unknown as Request;
}

/** A fully valid request, with any single field overridable. */
function signed(over: Partial<{ ts: string; nonce: string; body: Buffer; secret: string }> = {}) {
  const ts = over.ts ?? String(Date.now());
  const nonce = over.nonce ?? randomUUID();
  const body = over.body ?? Buffer.from('{"jsonrpc":"2.0","method":"tools/list","id":1}');
  const sig = sign('POST', '/mcp', ts, nonce, body, over.secret ?? SECRET);
  return {
    request: req({ 'x-origin-timestamp': ts, 'x-origin-nonce': nonce, 'x-origin-signature': sig }),
    body,
  };
}

afterEach(() => vi.useRealTimers());

describe('isOriginAuthVerificationEnabled', () => {
  afterEach(() => delete process.env.ORIGIN_AUTH_VERIFICATION_ENABLED);

  it('is off unless the flag is exactly true (case-insensitive)', () => {
    expect(isOriginAuthVerificationEnabled()).toBe(false);
    process.env.ORIGIN_AUTH_VERIFICATION_ENABLED = 'TRUE';
    expect(isOriginAuthVerificationEnabled()).toBe(true);
    process.env.ORIGIN_AUTH_VERIFICATION_ENABLED = 'yes';
    expect(isOriginAuthVerificationEnabled()).toBe(false);
  });
});

describe('verifyOriginAuth', () => {
  it('accepts a correctly signed request', () => {
    const { request, body } = signed();
    expect(verifyOriginAuth(request, body, SECRET)).toBe(true);
  });

  it.each(['x-origin-timestamp', 'x-origin-nonce', 'x-origin-signature'])(
    'rejects when %s is missing',
    header => {
      const { request, body } = signed();
      delete request.headers[header];
      expect(verifyOriginAuth(request, body, SECRET)).toBe(false);
    },
  );

  it('rejects a signature made with a different secret', () => {
    const { request, body } = signed({ secret: 'wrong-secret' });
    expect(verifyOriginAuth(request, body, SECRET)).toBe(false);
  });

  // The body hash is in the preimage, so a proxy cannot alter the payload in flight.
  it('rejects when the body no longer matches the signature', () => {
    const { request } = signed();
    expect(verifyOriginAuth(request, Buffer.from('{"tampered":true}'), SECRET)).toBe(false);
  });

  // Method and path are in the preimage: a signature for one route is not valid on another.
  it('rejects when the method or path differs from the signed one', () => {
    const ts = String(Date.now());
    const nonce = randomUUID();
    const body = Buffer.from('{}');
    const sig = sign('POST', '/mcp', ts, nonce, body);
    const headers = { 'x-origin-timestamp': ts, 'x-origin-nonce': nonce, 'x-origin-signature': sig };
    expect(verifyOriginAuth(req(headers, 'GET', '/mcp'), body, SECRET)).toBe(false);
    expect(verifyOriginAuth(req(headers, 'POST', '/authorize'), body, SECRET)).toBe(false);
  });

  it('rejects a non-numeric timestamp', () => {
    const { request, body } = signed({ ts: 'not-a-number' });
    expect(verifyOriginAuth(request, body, SECRET)).toBe(false);
  });

  // +/- 30s skew window.
  it('rejects a timestamp outside the skew window, in both directions', () => {
    const stale = signed({ ts: String(Date.now() - 31_000) });
    expect(verifyOriginAuth(stale.request, stale.body, SECRET)).toBe(false);
    const future = signed({ ts: String(Date.now() + 31_000) });
    expect(verifyOriginAuth(future.request, future.body, SECRET)).toBe(false);
  });

  it('accepts a timestamp inside the skew window', () => {
    const { request, body } = signed({ ts: String(Date.now() - 29_000) });
    expect(verifyOriginAuth(request, body, SECRET)).toBe(true);
  });

  // Replay protection: the same nonce must not be spendable twice.
  it('rejects a replayed nonce', () => {
    const { request, body } = signed();
    expect(verifyOriginAuth(request, body, SECRET)).toBe(true);
    expect(verifyOriginAuth(request, body, SECRET)).toBe(false);
  });

  // A rejected request must not burn the nonce, or a hostile prefix could lock out a real one.
  it('does not record a nonce when verification fails', () => {
    const ts = String(Date.now());
    const nonce = randomUUID();
    const body = Buffer.from('{}');
    const bad = req({
      'x-origin-timestamp': ts,
      'x-origin-nonce': nonce,
      'x-origin-signature': sign('POST', '/mcp', ts, nonce, body, 'wrong-secret'),
    });
    expect(verifyOriginAuth(bad, body, SECRET)).toBe(false);
    const good = req({
      'x-origin-timestamp': ts,
      'x-origin-nonce': nonce,
      'x-origin-signature': sign('POST', '/mcp', ts, nonce, body),
    });
    expect(verifyOriginAuth(good, body, SECRET)).toBe(true);
  });

  it('rejects a malformed hex signature of the wrong length', () => {
    const { request, body } = signed();
    request.headers['x-origin-signature'] = 'deadbeef';
    expect(verifyOriginAuth(request, body, SECRET)).toBe(false);
  });

  // The nonce cache holds entries for 60s; past that the entry is purged.
  it('frees a nonce once its TTL has elapsed', () => {
    vi.useFakeTimers();
    const nonce = randomUUID();
    const first = signed({ nonce });
    expect(verifyOriginAuth(first.request, first.body, SECRET)).toBe(true);
    vi.advanceTimersByTime(61_000);
    const second = signed({ nonce });
    expect(verifyOriginAuth(second.request, second.body, SECRET)).toBe(true);
  });
});

/** rawBody is undefined unless a parser claimed the request and ran the raw-bytes hook. */
describe('verifyOriginAuth with uncaptured bodies', () => {
  function headersFor(path: string, body: Buffer, extra: Record<string, string> = {}) {
    const ts = String(Date.now());
    const nonce = randomUUID();
    return {
      'x-origin-timestamp': ts,
      'x-origin-nonce': nonce,
      'x-origin-signature': sign('POST', path, ts, nonce, body),
      ...extra,
    };
  }

  it('refuses a body it could not hash, even when the signature covers an empty one', () => {
    const headers = headersFor('/token', Buffer.alloc(0), { 'content-length': '42' });
    expect(verifyOriginAuth(req(headers, 'POST', '/token'), undefined, SECRET)).toBe(false);
  });

  it('refuses a chunked body it could not hash', () => {
    const headers = headersFor('/token', Buffer.alloc(0), { 'transfer-encoding': 'chunked' });
    expect(verifyOriginAuth(req(headers, 'POST', '/token'), undefined, SECRET)).toBe(false);
  });

  it.each([undefined, '0'])('accepts a bodyless request with content-length %s', length => {
    const extra: Record<string, string> = length === undefined ? {} : { 'content-length': length };
    const headers = headersFor('/mcp', Buffer.alloc(0), extra);
    expect(verifyOriginAuth(req(headers, 'POST', '/mcp'), undefined, SECRET)).toBe(true);
  });
});

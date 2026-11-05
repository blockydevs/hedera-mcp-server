import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Request } from 'express';

/**
 * HMAC origin verification. A trusted edge proxy signs each request; the server checks
 * method, path, timestamp, nonce and a hash of the raw body. Requires the raw request bytes,
 * captured by createHttpApp in server/http-app.ts.
 */

const SKEW_MS = 30_000;
const NONCE_TTL_MS = 60 * 1000;
const MAX_NONCES = 100_000;

const seenNonces = new Map<string, number>();

function purgeExpiredNonces(now: number): void {
  for (const [nonce, expiresAt] of seenNonces) {
    if (expiresAt > now) {
      break;
    }
    seenNonces.delete(nonce);
  }
  if (seenNonces.size >= MAX_NONCES) {
    let toDelete = seenNonces.size - MAX_NONCES + 1;
    for (const nonce of seenNonces.keys()) {
      seenNonces.delete(nonce);
      if (--toDelete <= 0) {
        break;
      }
    }
  }
}

export function isOriginAuthVerificationEnabled(): boolean {
  return process.env.ORIGIN_AUTH_VERIFICATION_ENABLED?.toLowerCase() === 'true';
}

function hasRequestBody(req: Request): boolean {
  if (typeof req.headers['transfer-encoding'] === 'string') {
    return true;
  }
  const length = Number(req.headers['content-length']);
  return Number.isFinite(length) && length > 0;
}

export function verifyOriginAuth(
  req: Request,
  rawBody: Buffer | undefined,
  secret: string,
): boolean {
  // Bytes arrived but no parser captured them: refuse rather than verify against a body we
  // never read. The edge hashes what it received, so hashing an empty buffer only ever 401s.
  if (rawBody === undefined && hasRequestBody(req)) {
    return false;
  }
  const body = rawBody ?? Buffer.alloc(0);

  const ts = req.headers['x-origin-timestamp'];
  const nonce = req.headers['x-origin-nonce'];
  const sig = req.headers['x-origin-signature'];

  if (typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') {
    return false;
  }

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > SKEW_MS) {
    return false;
  }

  const now = Date.now();
  purgeExpiredNonces(now);

  const nonceExpiry = seenNonces.get(nonce);
  if (nonceExpiry !== undefined && nonceExpiry > now) {
    return false;
  }

  const bodyHash = createHash('sha256').update(body).digest('hex');
  const expected = createHmac('sha256', secret)
    .update([req.method, req.path, ts, nonce, bodyHash].join('\n'))
    .digest('hex');

  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return false;
  }

  seenNonces.set(nonce, now + NONCE_TTL_MS);
  return true;
}

let cachedOriginAuthSecret: string | null = null;

/** Read once at first use, not per request: the per-request syscall was a DoS amplifier. */
export async function loadOriginAuthSecret(): Promise<string> {
  if (cachedOriginAuthSecret) {
    return cachedOriginAuthSecret;
  }
  const secretFilePath = process.env.ORIGIN_AUTH_SECRET_FILE_PATH;
  if (!secretFilePath) {
    throw new Error(
      'Missing ORIGIN_AUTH_SECRET_FILE_PATH environment variable while ORIGIN_AUTH_VERIFICATION_ENABLED=true',
    );
  }
  cachedOriginAuthSecret = (await readFile(secretFilePath, 'utf-8')).trim();
  return cachedOriginAuthSecret;
}

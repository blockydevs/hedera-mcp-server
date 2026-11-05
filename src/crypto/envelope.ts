import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Application-level (envelope) encryption for secret-adjacent values at rest — specifically the
 * WalletConnect session keychain stored in the `wc_kv` table. A leaked database
 * must not expose the relay symmetric keys in plaintext.
 *
 * AES-256-GCM with a random 96-bit IV per value; the auth tag detects tampering. The key is
 * derived from a passphrase (the `WC_ENCRYPTION_KEY` env secret, injected from a secrets
 * manager in production) via scrypt, so any-length input yields a 32-byte key.
 *
 * Ciphertext is a self-describing string `enc:v1:<iv>:<tag>:<data>` (all base64). Values without
 * that prefix are treated as plaintext on read, so enabling encryption is backward-compatible
 * with rows written before it was turned on (they decrypt as-is and are re-encrypted on the
 * next write).
 */

const PREFIX = 'enc:v1:';
const KEY_LEN = 32;
const IV_LEN = 12;
const SCRYPT_SALT = 'hedera-mcp-wc-kv:v1';

/** Derives a 32-byte AES key from the passphrase, or returns undefined if none is configured. */
export function deriveEncryptionKey(passphrase: string | undefined): Buffer | undefined {
  if (!passphrase) return undefined;
  return scryptSync(passphrase, SCRYPT_SALT, KEY_LEN);
}

export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

export function decrypt(envelope: string, key: Buffer): string {
  if (!isEncrypted(envelope)) return envelope; // plaintext (pre-encryption row) — pass through
  const [ivB64, tagB64, dataB64] = envelope.slice(PREFIX.length).split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

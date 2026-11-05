import { describe, it, expect } from 'vitest';
import { deriveEncryptionKey, encrypt, decrypt, isEncrypted } from '../src/crypto/envelope.js';

const key = deriveEncryptionKey('a-strong-passphrase')!;

describe('envelope encryption', () => {
  it('round-trips a value', () => {
    const pt = JSON.stringify({ symKey: 'deadbeef', topic: 'abc' });
    const ct = encrypt(pt, key);
    expect(isEncrypted(ct)).toBe(true);
    expect(ct).not.toContain('deadbeef'); // secret not in the ciphertext
    expect(decrypt(ct, key)).toBe(pt);
  });

  it('produces different ciphertext each time (random IV)', () => {
    expect(encrypt('same', key)).not.toBe(encrypt('same', key));
  });

  it('fails to decrypt with the wrong key (auth tag)', () => {
    const ct = encrypt('secret', key);
    const wrong = deriveEncryptionKey('different')!;
    expect(() => decrypt(ct, wrong)).toThrow();
  });

  it('passes plaintext through (backward compat with pre-encryption rows)', () => {
    expect(decrypt('not-an-envelope', key)).toBe('not-an-envelope');
    expect(isEncrypted('not-an-envelope')).toBe(false);
  });

  it('derives no key when no passphrase is set', () => {
    expect(deriveEncryptionKey(undefined)).toBeUndefined();
  });
});

describe('envelope edge cases', () => {
  it('throws on a malformed envelope (truncated enc:v1:)', () => {
    expect(() => decrypt('enc:v1:onlyonepart', key)).toThrow(/Malformed encrypted envelope/);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { intEnv, numEnv, assertWcEncryptionConfig, WC_KEY_MIN_LENGTH } from '../src/config.js';

afterEach(() => { delete process.env.T_HOPS; });

describe('intEnv vs numEnv (count vs TTL semantics)', () => {
  it('intEnv allows 0 (trust no proxy)', () => {
    process.env.T_HOPS = '0';
    expect(intEnv('T_HOPS', 1)).toBe(0);        // numEnv would coerce this to the fallback
    expect(numEnv('T_HOPS', 1)).toBe(1);
  });
  it('intEnv accepts a positive integer', () => {
    process.env.T_HOPS = '2';
    expect(intEnv('T_HOPS', 1)).toBe(2);
  });
  it('intEnv rejects negatives and non-integers → fallback', () => {
    process.env.T_HOPS = '-1'; expect(intEnv('T_HOPS', 1)).toBe(1);
    process.env.T_HOPS = '1.5'; expect(intEnv('T_HOPS', 1)).toBe(1);
    process.env.T_HOPS = 'x'; expect(intEnv('T_HOPS', 1)).toBe(1);
  });
  it('intEnv uses the fallback when unset', () => {
    expect(intEnv('T_HOPS', 3)).toBe(3);
  });
});

describe('wc_kv encryption boot guard', () => {
  const strongKey = 'x'.repeat(WC_KEY_MIN_LENGTH);

  it('refuses to start in wallet mode without a key', () => {
    expect(() => assertWcEncryptionConfig(undefined, false, true)).toThrow(/PLAINTEXT/);
  });

  it('allows a missing key only with the explicit WC_ALLOW_PLAINTEXT opt-out', () => {
    expect(() => assertWcEncryptionConfig(undefined, true, true)).not.toThrow();
  });

  it('rejects a short key even with the plaintext opt-out set', () => {
    // The opt-out permits NO key; it must not launder a weak one.
    expect(() => assertWcEncryptionConfig('hunter2', true, true)).toThrow(/too short/);
    expect(() => assertWcEncryptionConfig('hunter2', false, true)).toThrow(/too short/);
  });

  it('accepts a key of the minimum length', () => {
    expect(() => assertWcEncryptionConfig(strongKey, false, true)).not.toThrow();
  });

  it('is inert in dev mode (no wallet signing)', () => {
    expect(() => assertWcEncryptionConfig(undefined, false, false)).not.toThrow();
    expect(() => assertWcEncryptionConfig('short', false, false)).not.toThrow();
  });
});

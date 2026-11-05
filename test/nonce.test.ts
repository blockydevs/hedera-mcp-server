import { describe, it, expect } from 'vitest';
import { NonceRegistry, buildSignInMessage } from '../src/auth/nonce.js';

describe('NonceRegistry', () => {
  it('issues a nonce bound to the domain and an issued-at time', () => {
    const registry = new NonceRegistry(60_000);
    const record = registry.issue('mcp.example.com');
    expect(record.domain).toBe('mcp.example.com');
    expect(Date.parse(record.issuedAt)).not.toBeNaN();
    expect(record.nonce).toHaveLength(32);
  });

  it('issues distinct nonces', () => {
    const registry = new NonceRegistry(60_000);
    expect(registry.issue('example.com').nonce).not.toBe(registry.issue('example.com').nonce);
  });

  it('consumes a valid nonce exactly once', () => {
    const registry = new NonceRegistry(60_000);
    const { nonce } = registry.issue('example.com');
    expect(registry.consume(nonce)).toBeDefined();
  });

  // Single-use is what stops a captured login proof being replayed.
  it('refuses a second use of the same nonce', () => {
    const registry = new NonceRegistry(60_000);
    const { nonce } = registry.issue('example.com');
    registry.consume(nonce);
    expect(registry.consume(nonce)).toBeUndefined();
  });

  it('refuses an unknown nonce', () => {
    expect(new NonceRegistry(60_000).consume('never-issued')).toBeUndefined();
  });

  it('refuses a nonce past its TTL', () => {
    const registry = new NonceRegistry(60_000);
    const now = Date.now();
    const { nonce } = registry.issue('example.com', now);
    expect(registry.consume(nonce, now + 60_001)).toBeUndefined();
  });

  it('accepts a nonce inside its TTL', () => {
    const registry = new NonceRegistry(60_000);
    const now = Date.now();
    const { nonce } = registry.issue('example.com', now);
    expect(registry.consume(nonce, now + 59_000)).toBeDefined();
  });

  it('prunes expired nonces so abandoned ceremonies cannot grow the map', () => {
    const registry = new NonceRegistry(60_000);
    const now = Date.now();
    registry.issue('example.com', now);
    registry.issue('example.com', now);
    expect(registry.size).toBe(2);
    registry.prune(now + 60_001);
    expect(registry.size).toBe(0);
  });
});

describe('buildSignInMessage', () => {
  const message = buildSignInMessage({
    domain: 'mcp.example.com',
    accountId: '0.0.1001',
    uri: 'https://mcp.example.com',
    chainId: 'hedera:testnet',
    nonce: 'abc123',
    issuedAt: '2026-07-20T10:00:00.000Z',
  });

  // Everything that scopes the signature must be inside the signed text, or it is not
  // actually bound by the signature.
  it('binds the domain, account, chain, nonce and issued-at into the signed text', () => {
    expect(message).toContain('mcp.example.com');
    expect(message).toContain('0.0.1001');
    expect(message).toContain('hedera:testnet');
    expect(message).toContain('Nonce: abc123');
    expect(message).toContain('Issued At: 2026-07-20T10:00:00.000Z');
  });

  it('tells the user plainly that signing moves no funds', () => {
    expect(message).toContain('does not move any funds');
  });
});

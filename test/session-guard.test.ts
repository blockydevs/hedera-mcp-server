import { describe, it, expect } from 'vitest';
import { isForeignSession } from '../src/auth/session-guard.js';

describe('isForeignSession', () => {
  it('flags a token account that differs from the session owner', () => {
    expect(isForeignSession('0.0.1001', '0.0.2002')).toBe(true);
  });
  it('allows the matching account', () => {
    expect(isForeignSession('0.0.1001', '0.0.1001')).toBe(false);
  });
  it('does not flag when there is no binding yet (new session)', () => {
    expect(isForeignSession(undefined, '0.0.2002')).toBe(false);
  });
  it('does not flag in dev mode (no token account)', () => {
    expect(isForeignSession('0.0.1001', undefined)).toBe(false);
  });
});

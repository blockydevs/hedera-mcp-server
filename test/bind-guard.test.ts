import { describe, it, expect } from 'vitest';
import { assertSecureBind } from '../src/server/bind-guard.js';

// The auth checks are injected via opts, so these run without touching env or config.
describe('assertSecureBind', () => {
  it('always allows loopback binds, even unauthenticated', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '']) {
      expect(() =>
        assertSecureBind(host, { authenticated: false, allowInsecure: false }),
      ).not.toThrow();
    }
  });

  it('refuses a non-loopback bind with no authentication', () => {
    expect(() =>
      assertSecureBind('0.0.0.0', { authenticated: false, allowInsecure: false }),
    ).toThrow(/Refusing to bind/);
  });

  it('allows a non-loopback bind when authenticated', () => {
    expect(() =>
      assertSecureBind('0.0.0.0', { authenticated: true, allowInsecure: false }),
    ).not.toThrow();
  });

  it('allows a non-loopback unauthenticated bind only under the explicit override', () => {
    expect(() =>
      assertSecureBind('0.0.0.0', { authenticated: false, allowInsecure: true }),
    ).not.toThrow();
  });
});

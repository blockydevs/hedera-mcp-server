import { describe, it, expect } from 'vitest';
import { SessionRegistry } from '../src/server/session-registry.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/** A transport stub exposing only what the registry touches: close(). */
function fakeTransport(): StreamableHTTPServerTransport & { closed: number } {
  const t = {
    closed: 0,
    close() {
      t.closed += 1;
      return Promise.resolve();
    },
  };
  return t as unknown as StreamableHTTPServerTransport & { closed: number };
}

describe('SessionRegistry', () => {
  it('tracks liveness and size', () => {
    const reg = new SessionRegistry();
    expect(reg.size).toBe(0);
    expect(reg.has('a')).toBe(false);

    const t = fakeTransport();
    reg.add('a', t, '0.0.1001');
    expect(reg.size).toBe(1);
    expect(reg.has('a')).toBe(true);
    expect(reg.get('a')).toBe(t);
  });

  it('removes a session and forgets its binding', () => {
    const reg = new SessionRegistry();
    reg.add('a', fakeTransport(), '0.0.1001');
    reg.remove('a');
    expect(reg.has('a')).toBe(false);
    expect(reg.size).toBe(0);
    // binding gone → no longer foreign to anyone
    expect(reg.isForeign('a', '0.0.2002')).toBe(false);
  });

  it('flags a foreign account but allows the session owner and dev mode', () => {
    const reg = new SessionRegistry();
    reg.add('a', fakeTransport(), '0.0.1001');
    expect(reg.isForeign('a', '0.0.2002')).toBe(true);
    expect(reg.isForeign('a', '0.0.1001')).toBe(false);
    expect(reg.isForeign('a', undefined)).toBe(false);
    // a session opened without an account (dev mode) is never foreign
    reg.add('b', fakeTransport());
    expect(reg.isForeign('b', '0.0.2002')).toBe(false);
  });

  it('evicts only sessions idle past the TTL and closes their transports', () => {
    const reg = new SessionRegistry(1000);
    const stale = fakeTransport();
    const fresh = fakeTransport();
    reg.add('stale', stale, '0.0.1');
    reg.add('fresh', fresh, '0.0.2');
    reg.touch('stale', 0);
    reg.touch('fresh', 10_000);

    const evicted = reg.evictIdle(10_000);
    expect(evicted).toEqual(['stale']);
    expect(stale.closed).toBe(1);
    expect(fresh.closed).toBe(0);
  });

  it('closes every transport on shutdown and empties itself', async () => {
    const reg = new SessionRegistry();
    const a = fakeTransport();
    const b = fakeTransport();
    reg.add('a', a);
    reg.add('b', b);
    await reg.closeAll();
    expect(a.closed).toBe(1);
    expect(b.closed).toBe(1);
    expect(reg.size).toBe(0);
  });

  /**
   * `touch` is reached from a GLOBAL middleware that runs before bearer auth, on paths the
   * rate limiter does not cover, keyed by an attacker-supplied `mcp-session-id` header. If it
   * retains anything for an id it has never seen, an unauthenticated caller can grow the
   * registry without bound and defeat MAX_SESSIONS.
   *
   * Asserting only `not.toThrow()` would pass even with unbounded growth — assert the
   * retention property instead.
   */
  it('touch on an unknown id retains nothing', () => {
    const reg = new SessionRegistry(60_000);
    // The leak is INVISIBLE through the public surface — `size`, `has` and `evictIdle` all
    // read `transports`, while the growth would be in `lastSeen`. That is why this reaches for
    // the private map: asserting through the public API passes either way.
    const lastSeen = (reg as unknown as { lastSeen: Map<string, number> }).lastSeen;

    for (let i = 0; i < 1_000; i++) reg.touch(`forged-${i}`);

    expect(lastSeen.size).toBe(0);
    expect(reg.size).toBe(0);
    expect(reg.has('forged-0')).toBe(false);
  });

  it('touch on a live session still defers the idle sweep', () => {
    const reg = new SessionRegistry(60_000);
    const transport = fakeTransport();
    reg.add('live', transport);

    // Without the touch this would be evicted; with it, activity is recorded.
    reg.touch('live', Date.now() + 90_000);
    expect(reg.evictIdle(Date.now() + 120_000)).toEqual([]);
  });
});

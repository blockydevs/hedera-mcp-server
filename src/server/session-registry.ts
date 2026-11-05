import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isForeignSession } from '../auth/session-guard.js';
import { logger } from '../logger.js';

/**
 * Owns the per-session runtime state — the transport, the account it was opened with, and a
 * last-seen stamp — behind a small tested surface, instead of three loose maps closed over by
 * `configureMcpHttp`. Keeps the account-binding (per-account isolation) and idle-eviction
 * logic in one place.
 *
 * In-memory and single-instance by design; see docs/SPEC.md §11.
 */
export class SessionRegistry {
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();
  private readonly accounts = new Map<string, string>();
  private readonly lastSeen = new Map<string, number>();

  constructor(private readonly idleTtlMs: number = 60 * 60 * 1000) {}

  get size(): number {
    return this.transports.size;
  }

  has(sessionId: string): boolean {
    return this.transports.has(sessionId);
  }

  get(sessionId: string): StreamableHTTPServerTransport | undefined {
    return this.transports.get(sessionId);
  }

  /** Records a live session and (in wallet mode) the account that opened it. */
  add(sessionId: string, transport: StreamableHTTPServerTransport, account?: string): void {
    this.transports.set(sessionId, transport);
    if (account) this.accounts.set(sessionId, account);
    this.lastSeen.set(sessionId, Date.now());
  }

  /**
   * Marks activity so the idle sweeper spares this session. A genuine no-op for unknown ids.
   *
   * The guard is load-bearing, not defensive tidiness: this is called from a GLOBAL request
   * middleware that runs before bearer auth and on paths outside the rate limiter, using an
   * attacker-supplied `mcp-session-id` header. Setting unconditionally let anyone grow this
   * map without bound — one entry per request, never reclaimed, since `remove()` only runs
   * for real sessions and `evictIdle()` iterates `transports`. That defeated MAX_SESSIONS,
   * which exists to bound exactly this memory.
   */
  touch(sessionId: string, at: number = Date.now()): void {
    if (this.transports.has(sessionId)) this.lastSeen.set(sessionId, at);
  }

  remove(sessionId: string): void {
    this.transports.delete(sessionId);
    this.accounts.delete(sessionId);
    this.lastSeen.delete(sessionId);
  }

  /** True if a request's token account differs from the account that opened the session. */
  isForeign(sessionId: string, tokenAccount: string | undefined): boolean {
    return isForeignSession(this.accounts.get(sessionId), tokenAccount);
  }

  /** Closes sessions idle past the TTL. Returns the ids evicted (their `onclose` removes them). */
  evictIdle(now: number = Date.now()): string[] {
    const cutoff = now - this.idleTtlMs;
    const evicted: string[] = [];
    for (const [sessionId, transport] of this.transports) {
      if ((this.lastSeen.get(sessionId) ?? 0) < cutoff) {
        logger.warn('evicting idle session', { sessionId: sessionId.slice(0, 8) + '…' });
        void transport.close();
        this.lastSeen.delete(sessionId);
        evicted.push(sessionId);
      }
    }
    return evicted;
  }

  /** Closes every transport (graceful shutdown), so the HTTP server can drain. */
  async closeAll(): Promise<void> {
    for (const [sessionId, transport] of this.transports) {
      try {
        await transport.close();
      } catch (error) {
        logger.error('error closing transport', { error: String(error) });
      }
      this.remove(sessionId);
    }
  }
}

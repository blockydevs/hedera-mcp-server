import { describe, it, expect, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { acquireInstanceLock, releaseInstanceLockGuard } from '../src/database/instance-lock.js';

/**
 * The lock itself needs Postgres (advisory locks are Postgres-specific), so these cover the
 * decision logic against a stubbed DataSource: the sqlite no-op, holding the connection open
 * on success, retry-then-refuse on contention, and the connection-loss guard that keeps a
 * dropped lock from silently leaving the process running without the invariant.
 */

interface StubOptions {
  results: boolean[];
  type?: string;
  /** Omit the driver client entirely, standing in for a TypeORM internals rename. */
  noDatabaseConnection?: boolean;
}

function stubDataSource({ results, type = 'postgres', noDatabaseConnection }: StubOptions): {
  dataSource: DataSource;
  released: () => number;
  runnersCreated: () => number;
  handlers: Map<string, (error: Error) => void>;
} {
  const queue = [...results];
  let releases = 0;
  let runners = 0;
  const handlers = new Map<string, (error: Error) => void>();

  const dataSource = {
    options: { type },
    createQueryRunner: () => ({
      __runner: ++runners,
      connect: async () => undefined,
      query: async () => [{ locked: queue.shift() ?? false }],
      release: async () => {
        releases++;
      },
      ...(noDatabaseConnection
        ? {}
        : {
            databaseConnection: {
              on: (event: string, cb: (error: Error) => void) => handlers.set(event, cb),
              removeListener: (event: string) => handlers.delete(event),
            },
          }),
    }),
  } as unknown as DataSource;

  return { dataSource, released: () => releases, runnersCreated: () => runners, handlers };
}

describe('instance lock', () => {
  it('is a no-op on sqlite — a second instance cannot exist against an in-memory database', async () => {
    const { dataSource, released } = stubDataSource({ results: [], type: 'better-sqlite3' });
    await expect(acquireInstanceLock(dataSource)).resolves.toBeUndefined();
    expect(released()).toBe(0);
  });

  it('holds the connection open when the lock is acquired', async () => {
    // Releasing the runner would end the session and drop the lock with it.
    const { dataSource, released } = stubDataSource({ results: [true] });
    await acquireInstanceLock(dataSource);
    expect(released()).toBe(0);
  });

  it('retries a held lock, then refuses to start and releases its connection', async () => {
    const { dataSource, released, runnersCreated } = stubDataSource({ results: [false, false] });
    await expect(
      acquireInstanceLock(dataSource, { attempts: 2, retryDelayMs: 0 }),
    ).rejects.toThrow(/already holds the database instance lock/);
    // Retries reuse the ONE session — the lock is session-scoped, so a fresh pool checkout
    // (and on a cold pool, a fresh handshake) per attempt would be pure waste.
    expect(runnersCreated()).toBe(1);
    expect(released()).toBe(1); // returned to the pool exactly once, on final failure
  });

  it('succeeds on a retry once the previous instance drains', async () => {
    const { dataSource, released, runnersCreated } = stubDataSource({ results: [false, true] });
    await acquireInstanceLock(dataSource, { attempts: 2, retryDelayMs: 0 });
    expect(runnersCreated()).toBe(1);
    expect(released()).toBe(0); // held open — releasing would drop the lock
  });

  it('reacts to lock loss instead of silently serving without the guarantee', async () => {
    // A Postgres restart/failover ends the pinned session and the lock dies with it. TypeORM's
    // own error handler just returns the connection to the pool, so without this the server
    // would keep running as if it still held the lock — and a second instance could start.
    const onLost = vi.fn();
    const { dataSource, handlers } = stubDataSource({ results: [true] });
    await acquireInstanceLock(dataSource, { onLost });

    expect(handlers.has('error')).toBe(true);
    handlers.get('error')!(new Error('connection terminated unexpectedly'));
    expect(onLost).toHaveBeenCalledOnce();
  });

  it('refuses to start if the driver connection cannot be guarded', async () => {
    // Stands in for a TypeORM upgrade renaming `databaseConnection`. Skipping the guard
    // silently would restore the very failure it exists to catch, so boot must fail instead.
    const { dataSource } = stubDataSource({ results: [true], noDatabaseConnection: true });
    await expect(acquireInstanceLock(dataSource)).rejects.toThrow(/no longer exposes/);
  });

  it('stops guarding on shutdown, so teardown errors do not fail a clean exit', async () => {
    const onLost = vi.fn();
    const { dataSource, handlers } = stubDataSource({ results: [true] });
    await acquireInstanceLock(dataSource, { onLost });

    releaseInstanceLockGuard();

    expect(handlers.has('error')).toBe(false);
    expect(onLost).not.toHaveBeenCalled();
  });
});

import type { DataSource, QueryRunner } from 'typeorm';
import { logger } from '../logger.js';

/**
 * Enforces the single-instance topology as a runtime invariant rather than a documented
 * assumption. Several guarantees quietly depend on exactly one server process per database —
 * the in-memory auth-code claim map, migrations running without an advisory lock, and the
 * in-memory nonce/ceremony/pending-signing state — so a second replica pointed at the same
 * database must refuse to boot instead of silently weakening them.
 *
 * Implemented as a Postgres session-level advisory lock held on a dedicated connection for the
 * life of the process, released when that session ends (graceful shutdown via
 * `DataSource.destroy()`, or process death). Two operational constraints follow from that:
 *
 * - **`DATABASE_URL` must be a direct connection, not a transaction-pooling proxy.** Under
 *   PgBouncer in transaction mode the lock lands on an arbitrary backend that is then returned
 *   to the pool, so the lock is silently ineffective (or leaks onto a pooled backend).
 * - **Deploys must stop the old instance before starting the new one.** A start-before-stop
 *   rolling deploy overlaps two processes by design; the boot retry below covers a short drain
 *   window, but a K8s `RollingUpdate` that waits for the new pod's readiness will not converge.
 */

/** Advisory-lock key name; hashed and scoped to the current database at acquisition time. */
const LOCK_NAME = 'hedera-mcp-server:instance';

/**
 * Advisory locks are cluster-wide, not per-database, so the key is the pair
 * (name, current database OID) — otherwise two unrelated deployments sharing one Postgres
 * cluster (staging + prod on the same instance) would lock each other out.
 */
const TRY_LOCK_SQL = `
  SELECT pg_try_advisory_lock(
    hashtext($1),
    (SELECT oid::int FROM pg_database WHERE datname = current_database())
  ) AS locked
`;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * TypeORM attaches its own `'error'` listener when the QueryRunner connects, and that listener
 * *releases the connection back to the pool*. So a backend termination (Postgres restart,
 * failover) does not crash the process — it does something quieter and worse: the pinned
 * session ends, the advisory lock dies with it, and the server keeps running as if it still
 * held the single-instance guarantee. A second instance could then start successfully.
 *
 * This listener exists to make that failure loud. The lock cannot be meaningfully re-acquired
 * in place (another process may already have taken it), so the process exits deliberately and
 * lets the orchestrator restart it through the normal acquisition path.
 */
function guardLockConnection(runner: QueryRunner, onLost: () => void): () => void {
  // `databaseConnection` is the driver-level client (pg's `Client` here) and is not on the base
  // QueryRunner interface, so it is reached structurally — which means a TypeORM upgrade could
  // rename it out from under us. Fail loudly if the shape drifts: silently skipping the listener
  // would restore the exact silent-lock-loss this guards against, and a boot-time check that
  // quietly does nothing is worse than no check at all.
  const { databaseConnection: client } = runner as QueryRunner & {
    databaseConnection?: {
      on?: (event: string, cb: (error: Error) => void) => void;
      removeListener?: (event: string, cb: (error: Error) => void) => void;
    };
  };
  if (typeof client?.on !== 'function') {
    throw new Error(
      'Cannot guard the instance-lock connection: the TypeORM QueryRunner no longer exposes a ' +
        '`databaseConnection` with an `on` method. Without it, losing the lock connection would ' +
        'go undetected and the single-instance guarantee could not be relied on. Refusing to start.',
    );
  }

  const onError = (error: Error): void => {
    logger.error('instance-lock connection lost — the single-instance guarantee no longer holds', {
      error: error.message,
    });
    onLost();
  };
  client.on('error', onError);

  // Returned rather than stored here: the caller owns the lock's lifecycle, so it owns the
  // detacher. Graceful shutdown must detach before the pool ends its clients, since a socket
  // error on a connection already on its way out would otherwise fire `onLost` and turn a
  // clean exit(0) into exit(1).
  return () => {
    client.removeListener?.('error', onError);
    detachLockGuard = undefined;
  };
}

let detachLockGuard: (() => void) | undefined;

/**
 * Stops the lock-loss guard from firing. Call immediately before `DataSource.destroy()` on the
 * shutdown path: past that point the lock is *meant* to go away, so its loss is not a failure.
 */
export function releaseInstanceLockGuard(): void {
  detachLockGuard?.();
}

export interface InstanceLockOptions {
  /** Invoked when the lock connection dies after a successful acquisition. Defaults to exiting. */
  onLost?: () => void;
  /** Overridable for tests. */
  attempts?: number;
  retryDelayMs?: number;
}

export async function acquireInstanceLock(
  dataSource: DataSource,
  options: InstanceLockOptions = {},
): Promise<void> {
  // Advisory locks are Postgres-specific; the sqlite used by tests is in-memory and
  // per-process, so a second instance against the same database cannot exist there.
  if (dataSource.options.type !== 'postgres') return;

  const { attempts = 5, retryDelayMs = 250, onLost = () => process.exit(1) } = options;

  // ONE QueryRunner for every attempt: the advisory lock is session-scoped, so retrying on the
  // same session is correct, and a fresh runner per attempt would mean up to five pool
  // checkouts (each a TCP+TLS+auth handshake on a cold pool) to re-run a single SELECT.
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  let acquired = false;
  try {
    // Exponential from 250ms (250/500/1000/2000): this blocks boot before the HTTP listener
    // binds, so it covers a stop-then-start drain window without a fixed multi-second stall.
    // It does NOT make start-before-stop deploys work — nothing here can.
    let delayMs = retryDelayMs;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const rows: Array<{ locked: boolean }> = await runner.query(TRY_LOCK_SQL, [LOCK_NAME]);
      if (rows[0]?.locked === true) {
        // Guard first: if the connection cannot be guarded we must NOT keep the runner, so
        // `acquired` is only set once the guard is actually installed.
        detachLockGuard = guardLockConnection(runner, onLost);
        acquired = true;
        return; // keep the runner (and its session) open — releasing it would drop the lock
      }
      if (attempt < attempts) {
        logger.warn('instance lock held by another process — retrying', { attempt, attempts });
        await sleep(delayMs);
        delayMs *= 2;
      }
    }
  } finally {
    if (!acquired) await runner.release();
  }

  throw new Error(
    'Another server instance already holds the database instance lock. Single-instance is a ' +
      'hard requirement of this deployment (docs/DATABASE.md) — do not run multiple replicas ' +
      'against the same database, and stop the old instance before starting a new one. ' +
      'Refusing to start.',
  );
}

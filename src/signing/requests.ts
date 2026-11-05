import { randomUUID } from 'node:crypto';
import { SessionGoneError, type WalletApprover } from '../wallet/approver.js';
import { logger } from '../logger.js';

/**
 * The async signing surface.
 *
 * A wallet approval takes as long as a human takes, and MCP clients cap tool calls at
 * roughly 60s. So `submit()` fires the WalletConnect request and returns immediately with
 * a requestId; the promise resolves in the background and updates the record, which the
 * agent reads via `check_signing_status`. Nothing ever blocks on a person.
 *
 * Records are in-memory by design: they are short-lived and hold transaction
 * bytes, which we do not persist. A restart drops them, and a dropped record reads as
 * `expired` — the honest answer, since we cannot know whether the wallet acted.
 */

export type SigningStatus =
  | 'awaiting_approval'
  | 'confirming'
  | 'executed'
  | 'rejected'
  | 'failed'
  | 'expired'
  | 'needs_reauth';

/** Terminal states — a request in one of these never changes again. */
const TERMINAL_STATES: SigningStatus[] = ['executed', 'rejected', 'failed', 'expired', 'needs_reauth'];

/** Outcome of a mirror-node lookup for a broadcast transaction. */
export type ConfirmResult = 'success' | 'failed' | 'not_found';

/** Looks a transaction up on the mirror node. Injected so it can be faked in tests. */
export type ConfirmFn = (transactionId: string) => Promise<ConfirmResult>;

export interface ConfirmOptions {
  /** How many times to poll before giving up (mirror nodes lag consensus by seconds). */
  attempts: number;
  delayMs: number;
  /** Per-call ceiling so a hung mirror fetch can't strand a request in `confirming`. */
  callTimeoutMs: number;
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Rejects if `promise` doesn't settle within `ms` (0 or less disables the cap). */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!(ms > 0)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('confirm call timed out')), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      // Forward the ORIGINAL rejection rather than wrapping it: callers discriminate on the
      // concrete type (e.g. SessionGoneError), which wrapping would erase.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Converts an SDK transaction id (`0.0.x@1700000000.123456789`) to the mirror-node REST
 * form (`0.0.x-1700000000-123456789`). The account part keeps its dots; only the `@` and the
 * seconds/nanos separator become dashes. Passed through unchanged if it has no `@`.
 */
export function toMirrorTransactionId(transactionId: string): string {
  const at = transactionId.indexOf('@');
  if (at === -1) return transactionId;
  const account = transactionId.slice(0, at);
  const stamp = transactionId.slice(at + 1).replace('.', '-');
  return `${account}-${stamp}`;
}

export interface SigningRequest {
  requestId: string;
  accountId: string;
  topic: string;
  status: SigningStatus;
  summary: string;
  walletVerifiable: boolean;
  transactionId?: string;
  error?: string;
  createdAt: number;
  expiresAt: number;
}

export interface SubmitParams {
  accountId: string;
  topic: string;
  transactionBase64: string;
  summary: string;
  walletVerifiable: boolean;
}

export class SigningRequestRegistry {
  private readonly requests = new Map<string, SigningRequest>();

  constructor(
    private readonly approver: WalletApprover,
    private readonly ttlMs: number,
    private readonly confirm?: ConfirmFn,
    private readonly confirmOptions: ConfirmOptions = { attempts: 5, delayMs: 2000, callTimeoutMs: 10_000 },
  ) {}

  submit(params: SubmitParams): SigningRequest {
    const now = Date.now();
    const request: SigningRequest = {
      requestId: randomUUID(),
      accountId: params.accountId,
      topic: params.topic,
      status: 'awaiting_approval',
      summary: params.summary,
      walletVerifiable: params.walletVerifiable,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.requests.set(request.requestId, request);
    logger.info('signing request created', {
      requestId: request.requestId,
      accountId: request.accountId,
      walletVerifiable: request.walletVerifiable,
    });

    // Intentionally not awaited: this settles when the human does.
    void this.approver
      .signAndExecute(params.topic, params.accountId, params.transactionBase64)
      .then(({ transactionId }) => this.onBroadcast(request.requestId, transactionId))
      .catch((error: unknown) => {
        this.transition(request.requestId, ['awaiting_approval'], current => {
          if (error instanceof SessionGoneError) {
            current.status = 'needs_reauth';
          } else if (isUserRejection(error)) {
            current.status = 'rejected';
          } else {
            current.status = 'expired';
          }
          current.error = error instanceof Error ? error.message : String(error);
        });
      });

    return request;
  }

  /**
   * The wallet has signed and broadcast — but that is not proof of consensus. Without a
   * mirror-node check a stale-window approval (broadcast after the ~180 s validity lapsed)
   * would be reported as `executed` with a HashScan link to a transaction that never landed.
   * So we record the id, enter `confirming`, and only report `executed` once the mirror node
   * confirms success; a failed result becomes `failed`, and a never-appearing one `expired`.
   *
   * With no confirm function wired (dev/tests) we fall back to trusting the wallet.
   */
  private async onBroadcast(requestId: string, transactionId: string): Promise<void> {
    // A returned transactionId means the wallet actually broadcast — a fact that outranks a
    // client-side timeout. If the request had already flipped to `expired` (TTL) or
    // `needs_reauth` (a racing session_delete) while the broadcast was in flight, record it
    // anyway and let the mirror node decide; otherwise a real transfer is silently dropped
    // and the agent is told to retry, landing it twice. `rejected`/`executed`/`failed` cannot
    // co-occur with a resolved broadcast, so they are safely excluded.
    const broadcastFrom: SigningStatus[] = ['awaiting_approval', 'expired', 'needs_reauth'];

    if (!this.confirm) {
      this.transition(requestId, broadcastFrom, current => {
        current.status = 'executed';
        current.transactionId = transactionId;
        current.error = undefined;
      });
      return;
    }

    this.transition(requestId, broadcastFrom, current => {
      current.status = 'confirming';
      current.transactionId = transactionId;
      current.error = undefined;
    });

    const result = await this.pollConfirmation(transactionId);
    this.transition(requestId, ['confirming'], current => {
      if (result === 'success') {
        current.status = 'executed';
      } else if (result === 'failed') {
        current.status = 'failed';
        current.error = 'Transaction reached the network but failed on-chain';
      } else {
        current.status = 'expired';
        current.error =
          'Transaction not found on the mirror node — it likely expired before approval or failed to broadcast';
      }
    });
  }

  private async pollConfirmation(transactionId: string): Promise<ConfirmResult> {
    const { attempts, delayMs, callTimeoutMs } = this.confirmOptions;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let result: ConfirmResult;
      try {
        // Cap each confirm call: a mirror fetch that HANGS (rather than rejects) would
        // otherwise strand the request in `confirming` forever — a state neither TTL nor
        // prune reclaims. A timeout is treated as not-yet-found and retried.
        result = await withTimeout(this.confirm!(transactionId), callTimeoutMs);
      } catch {
        // A mirror error (including the 404 the record endpoint throws before the tx is
        // indexed) or a timeout is not a verdict — treat it as not-yet-found and retry.
        result = 'not_found';
      }
      if (result !== 'not_found') return result;
      if (attempt < attempts - 1 && delayMs > 0) await delay(delayMs);
    }
    return 'not_found';
  }

  /** Applies a mutation only when the request is in one of the allowed source states. */
  private transition(
    requestId: string,
    allowedFrom: SigningStatus[],
    mutate: (request: SigningRequest) => void,
  ): void {
    const request = this.requests.get(requestId);
    if (!request || !allowedFrom.includes(request.status)) return;
    const from = request.status;
    mutate(request);
    if (request.status !== from) {
      // One correlated line per lifecycle transition — traces a request across the async hops.
      logger.info('signing request transition', {
        requestId,
        accountId: request.accountId,
        from,
        to: request.status,
        transactionId: request.transactionId,
        error: request.error,
      });
    }
  }

  /**
   * Reads current status, applying TTL lazily. A request whose TTL lapsed while still
   * awaiting approval becomes `expired`: any transaction we issued is dead, and since we
   * hold only opaque bytes the agent must re-run the write tool to get fresh ones.
   */
  get(requestId: string, now: number = Date.now()): SigningRequest | undefined {
    const request = this.requests.get(requestId);
    if (!request) return undefined;
    if (request.status === 'awaiting_approval' && request.expiresAt <= now) {
      request.status = 'expired';
      request.error = 'Request TTL lapsed before the user approved';
    }
    return request;
  }

  /**
   * Long-poll: resolves as soon as the request reaches a terminal state (the user approved,
   * rejected, or it expired), or after `timeoutMs`, returning the current state either way.
   * This lets `check_signing_status` block until the human acts instead of the agent polling
   * repeatedly or asking the user "done?" — while the bounded timeout keeps a single call under
   * the MCP client's ~60 s tool-call limit. Cheap in-memory polling; non-blocking (awaits).
   */
  async waitForResolution(requestId: string, timeoutMs: number): Promise<SigningRequest | undefined> {
    const deadline = Date.now() + timeoutMs;
    const POLL_MS = 400;
    for (;;) {
      const request = this.get(requestId);
      if (!request || TERMINAL_STATES.includes(request.status)) return request;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return request; // still pending — hand back the non-terminal state
      await delay(Math.min(POLL_MS, remaining));
    }
  }

  /** Number of requests still awaiting a decision for an account — enforces the per-account approval quota. */
  countAwaiting(accountId: string, now: number = Date.now()): number {
    let count = 0;
    for (const request of this.requests.values()) {
      if (request.accountId === accountId && this.get(request.requestId, now)?.status === 'awaiting_approval') {
        count += 1;
      }
    }
    return count;
  }

  /** Marks every live request on a dead session, so status reads say `needs_reauth` not `awaiting_approval`. */
  markSessionGone(topic: string): void {
    for (const request of this.requests.values()) {
      if (request.topic === topic && request.status === 'awaiting_approval') {
        request.status = 'needs_reauth';
        request.error = 'Wallet session ended before approval';
      }
    }
  }

  /** Drops records that are terminal and past TTL, bounding memory. `confirming` is spared. */
  prune(now: number = Date.now()): void {
    for (const [requestId, request] of this.requests) {
      if (TERMINAL_STATES.includes(request.status) && request.expiresAt <= now) {
        this.requests.delete(requestId);
      }
    }
  }

  get size(): number {
    return this.requests.size;
  }
}

/** WalletConnect surfaces a user decline as a JSON-RPC error rather than a typed rejection. */
export function isUserRejection(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes('reject') || message.includes('declin') || message.includes('user denied')
  );
}

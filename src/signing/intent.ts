import { createHash } from 'node:crypto';
import { Transaction, TransferTransaction, Hbar } from '@hiero-ledger/sdk';
import { transactionKind, effectiveTransaction } from './transaction.js';

/**
 * Structured intent captured while a write transaction is still being built, keyed so the
 * later, separate `sign_with_wallet` call can find it again.
 *
 * Why this exists: the write tool and `sign_with_wallet` are two independent tool calls, and
 * the only thing that travels between them is the transaction bytes (relayed by the model).
 * A `postCoreActionHook` fires on the transaction *before it is frozen* and has the tool
 * name, the normalised params, and a clean view of the transaction — everything needed for a
 * faithful summary (and the params a rebuild on expiry would need). We record it here, then look
 * it up in `sign_with_wallet` by a fingerprint both sides can compute.
 *
 * The fingerprint is content-based, over fields that survive freezing. It deliberately does
 * NOT use the transaction id or node account ids: at hook time (before freeze) those are
 * still null — they are only assigned during `freezeWith`, after the hook has run.
 *
 * In-memory and ephemeral by design: intents are short-lived and hold no secrets.
 */

export interface CapturedIntent {
  /** The Agent Kit tool that built this transaction, e.g. `transfer_hbar_tool`. */
  toolMethod: string;
  /** Human-facing type label from {@link transactionKind}. */
  txKind: string;
  /** One-line summary produced while the structured params were still in hand. */
  summary: string;
  /** Whether a wallet can fully decode this type for the user. */
  walletVerifiable: boolean;
  /** The memo present after the hook ran (possibly one the hook stamped). */
  memo: string;
  /** Normalised params — retained for a possible server-side re-issue; not read today. */
  normalisedParams: unknown;
  capturedAt: number;
}

/**
 * A stable fingerprint of a transaction's content.
 *
 * Computed identically before freeze (in the hook) and after freeze (in `sign_with_wallet`,
 * from the decoded bytes), because it reads only fields freezing leaves untouched. Never
 * throws — a fingerprint failure must never break signing, so it degrades to a weaker key.
 *
 * Limitation, stated honestly: for types without a dedicated extractor the key is only
 * `kind + memo`, so two in-flight transactions of the same type and memo can collide. The
 * consequence is bounded — a collision can only attach the wrong *summary*; the payer check
 * and the memo (the security-relevant parts) never depend on this. A server-side re-issue
 * would need a stronger key.
 */
export function fingerprintTransaction(tx: Transaction): string {
  // Key off the OUTER kind + memo (a schedule stamps its memo on the wrapper), but read the
  // transfer legs from the EFFECTIVE (unwrapped) transaction so a scheduled transfer keys on
  // its real content. Both HBAR and token legs are included — omitting token legs let two
  // token-only transfers with the same memo collide onto one summary.
  const effective = effectiveTransaction(tx);
  const parts: string[] = [transactionKind(tx), tx.transactionMemo ?? ''];
  try {
    if (effective instanceof TransferTransaction) {
      const legs: string[] = [];
      for (const [account, amount] of effective.hbarTransfers ?? new Map<unknown, Hbar>()) {
        legs.push(`h:${account}:${(amount).toString()}`);
      }
      for (const [token, accountAmounts] of effective.tokenTransfers) {
        for (const [account, amount] of accountAmounts) {
          legs.push(`t:${token}:${account}:${amount.toString()}`);
        }
      }
      legs.sort();
      parts.push(legs.join(','));
    }
  } catch {
    // Field extraction failed — fall back to the kind+memo key rather than throw.
  }
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

export class IntentRegistry {
  private readonly intents = new Map<string, CapturedIntent>();

  constructor(private readonly ttlMs: number) {}

  record(fingerprint: string, intent: CapturedIntent): void {
    this.intents.set(fingerprint, intent);
  }

  /** Reads a captured intent without removing it, applying TTL lazily. */
  get(fingerprint: string, now: number = Date.now()): CapturedIntent | undefined {
    const intent = this.intents.get(fingerprint);
    if (!intent) return undefined;
    if (intent.capturedAt + this.ttlMs <= now) {
      this.intents.delete(fingerprint);
      return undefined;
    }
    return intent;
  }

  /** Drops expired intents, bounding memory if a build is never followed by a sign. */
  prune(now: number = Date.now()): void {
    for (const [fingerprint, intent] of this.intents) {
      if (intent.capturedAt + this.ttlMs <= now) this.intents.delete(fingerprint);
    }
  }

  get size(): number {
    return this.intents.size;
  }
}

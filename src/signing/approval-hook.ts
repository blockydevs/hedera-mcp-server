import { Transaction } from '@hiero-ledger/sdk';
import { AbstractHook } from '@hashgraph/hedera-agent-kit';
import {
  coreAccountPluginToolNames,
  coreTokenPluginToolNames,
  coreConsensusPluginToolNames,
  coreEVMPluginToolNames,
} from '@hashgraph/hedera-agent-kit/plugins';
import { isWalletVerifiable, transactionKind, summarise } from './transaction.js';
import { fingerprintTransaction, type IntentRegistry } from './intent.js';

/**
 * The one seam that lets the wallet path enrich a transaction without changing the tools.
 *
 * `BaseTool.execute` fires `postCoreActionHook` on the built-but-not-yet-frozen transaction
 * (before `secondaryAction` → `freezeWith`), and reads `context.hooks`, which this server
 * populates. So this hook runs on the *unfrozen* transaction and can:
 *
 *  1. Stamp a human-readable memo on opaque types. A memo set here survives into
 *     the returned bytes; the same call after freeze throws `transaction is immutable`,
 *     which is exactly why `sign_with_wallet` (which only sees frozen bytes) cannot do it.
 *  2. Record structured intent (tool + normalised params + a faithful summary) into the
 *     IntentRegistry, so `sign_with_wallet` can present a real summary instead of
 *     re-deriving one lossily from bytes — and so the params are on hand should the server
 *     ever rebuild an expired transaction.
 *
 * The transaction never leaves the process, no key is involved, and the write tools are
 * untouched — the hook only annotates what they already build.
 */

/** ASCII, ≤100 bytes (the Hedera memo limit). No em-dash: that is 3 bytes in UTF-8. */
const OPAQUE_MEMO = 'Hedera MCP: wallet cannot fully decode this call - verify intent before approving';

/** Truncate to a byte budget without splitting a multi-byte character (Hedera limits memos by BYTES). */
function truncateUtf8(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= maxBytes) return value;
  // Drop the trailing replacement char a mid-character cut would leave behind.
  return Buffer.from(buf.subarray(0, maxBytes)).toString('utf8').replace(/�+$/, '');
}

/** Every write tool the hook should annotate, derived from the exported tool-name maps. */
export const WRITE_TOOL_METHODS: string[] = [
  ...Object.values(coreAccountPluginToolNames),
  ...Object.values(coreTokenPluginToolNames),
  ...Object.values(coreConsensusPluginToolNames),
  ...Object.values(coreEVMPluginToolNames),
];

export class WalletApprovalHook extends AbstractHook {
  name = 'wallet-approval';
  description = 'Stamps a memo on opaque transactions and records intent before freeze.';
  relevantTools = WRITE_TOOL_METHODS;

  constructor(private readonly intents: IntentRegistry) {
    super();
  }

  async postCoreActionHook(
    params: { coreActionResult: unknown; normalisedParams: unknown },
    method: string,
  ): Promise<void> {
    if (!this.relevantTools.includes(method)) return;

    const tx = params.coreActionResult;
    // Some write tools (schedule sign/delete) may not yield a plain Transaction; and if a
    // transaction is somehow already frozen, mutating it would throw. Skip both defensively.
    if (!(tx instanceof Transaction) || tx.isFrozen()) return;

    this.stampMemo(tx);

    // Fingerprint AFTER stamping, so both sides hash the same (post-stamp) memo.
    this.intents.record(fingerprintTransaction(tx), {
      toolMethod: method,
      txKind: transactionKind(tx),
      summary: summarise(tx),
      walletVerifiable: isWalletVerifiable(tx),
      memo: tx.transactionMemo ?? '',
      normalisedParams: params.normalisedParams,
      capturedAt: Date.now(),
    });
  }

  /**
   * Guarantees a human-readable memo on types a wallet cannot decode. Verifiable types
   * render themselves in the wallet, so they are left alone; an existing (agent-supplied) memo
   * is always respected rather than overwritten.
   */
  private stampMemo(tx: Transaction): void {
    if (isWalletVerifiable(tx)) return;
    if (tx.transactionMemo && tx.transactionMemo.trim().length > 0) return;
    try {
      tx.setTransactionMemo(truncateUtf8(OPAQUE_MEMO, 100));
    } catch {
      // Unexpectedly frozen — better to sign without a memo than to fail the whole write.
    }
  }
}

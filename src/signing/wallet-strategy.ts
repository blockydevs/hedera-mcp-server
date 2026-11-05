import { Client, Transaction, TransactionId } from '@hiero-ledger/sdk';
import { AgentMode, type Context } from '@hashgraph/hedera-agent-kit';
import { buildApprovalResponse, type ApprovalResponse, type WalletToolContext } from './tools.js';
import type { SigningRequestRegistry } from './requests.js';
import type { IntentRegistry } from './intent.js';
import { messageOf } from '../util.js';

/**
 * The wallet path expressed as an agent-kit transaction strategy.
 *
 * Every transaction tool ends its pipeline by calling `handleTransaction`, which dispatches to
 * `context.transactionStrategy` in `CUSTOM_RETURN_BYTES` mode. Installing this strategy makes
 * "deliver to the user's wallet" the tools' own terminal step, so wallet-vs-dev is decided ONCE
 * when the session context is built rather than per tool at registration time. The tools
 * themselves stay untouched.
 *
 * The strategy receives the transaction unfrozen (the memo hook has already run on it), freezes
 * it exactly as the kit's own `ReturnBytesStrategy` does, and then hands it to
 * {@link buildApprovalResponse} — the single chokepoint that also serves `sign_with_wallet`, so
 * the payer/debit/quota checks have one implementation regardless of how a transaction arrived.
 */

/** Brand identifying a result this strategy produced. Nothing in the kit emits it. */
export const WALLET_DELIVERY = 'wallet-delivery';

/**
 * What this strategy hands back to the tool pipeline: a TAGGED UNION carrying the kit's
 * `{ bytes }` alongside exactly one outcome.
 *
 * It is a superset of `ReturnBytesStrategyResult` deliberately — the kit documents
 * `CUSTOM_RETURN_BYTES` as returning `{ bytes }` and types `Context.transactionStrategy` to
 * match, so returning only an approval would mean casting past a documented contract. Bytes
 * stay here; `renderToolResult` emits only the outcome, so they never travel to the model.
 *
 * The `kind` brand and the union are what make a refusal impossible to misread. `BaseTool.execute`
 * wraps the pipeline in try/catch and converts a throw into its own `{ raw: { status: 'ERROR' } }`
 * envelope rather than rethrowing, so a guard rejection (foreign debit, approval quota) arrives
 * as ordinary data. Discriminating on a brand the kit cannot produce — instead of probing for
 * the presence of a field — means an unrecognised shape can never fall through as a success.
 */
export type WalletDeliveryResult = {
  /** Frozen bytes — satisfies the kit's contract for this mode. Never sent to the model. */
  bytes: Uint8Array;
  /** Mirrors the kit's own field so a kit-side consumer classifies this result correctly. */
  status: string;
  kind: typeof WALLET_DELIVERY;
} & ({ approval: ApprovalResponse; approvalRefused?: never } | { approvalRefused: string; approval?: never });

export function isWalletDeliveryResult(value: unknown): value is WalletDeliveryResult {
  return (value as WalletDeliveryResult | null)?.kind === WALLET_DELIVERY;
}

/**
 * The agent kit's own error envelope, emitted by `BaseTool.handleError` when any step of the
 * pipeline throws. Kept here with the rest of the kit-shape knowledge rather than in the MCP
 * renderer, so a kit upgrade has one place to check. Its shape already changed once, in 4.1.0.
 */
export function kitErrorMessage(value: unknown): string | undefined {
  const envelope = value as { raw?: { status?: string }; humanMessage?: string } | null;
  if (envelope?.raw?.status !== 'ERROR') return undefined;
  return envelope.humanMessage ?? 'Tool execution failed';
}

export interface WalletStrategyDeps {
  walletContext: WalletToolContext;
  registry: SigningRequestRegistry;
  intents: IntentRegistry;
}

export class WalletDeliveryStrategy {
  constructor(private readonly deps: WalletStrategyDeps) {}

  async handle(
    transaction: Transaction,
    client: Client,
    context: Context,
  ): Promise<WalletDeliveryResult> {
    // `getStrategyFromContext` hands the same `transactionStrategy` to BOTH custom modes, so a
    // context set to CUSTOM_EXECUTE_TX would run this strategy in a mode whose callers expect
    // an execution receipt. Refuse rather than return an approval envelope to an executor.
    if (context.mode !== AgentMode.CUSTOM_RETURN_BYTES) {
      throw new Error(
        `WalletDeliveryStrategy requires agent mode ${AgentMode.CUSTOM_RETURN_BYTES}, got ` +
          `${String(context.mode)}. This server never executes transactions itself.`,
      );
    }
    if (!context.accountId) {
      throw new Error('Account ID is required in context to deliver a transaction for approval');
    }

    // Freeze exactly as the kit's ReturnBytesStrategy does: the payer is the session account,
    // and freezing here is what makes the transaction immutable for the guards below.
    transaction.setTransactionId(TransactionId.generate(context.accountId)).freezeWith(client);
    // Read once, after freeze: the transaction is immutable from here, so these bytes are
    // exactly what buildApprovalResponse hands to the wallet.
    const bytes = transaction.toBytes();

    try {
      const approval = buildApprovalResponse(
        transaction,
        this.deps.walletContext,
        this.deps.registry,
        this.deps.intents,
      );
      return { bytes, status: 'SUCCESS', kind: WALLET_DELIVERY, approval };
    } catch (error) {
      // A refused transaction is a normal outcome (the guards did their job), not a crash.
      return { bytes, status: 'ERROR', kind: WALLET_DELIVERY, approvalRefused: messageOf(error) };
    }
  }
}

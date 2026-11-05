import type { WalletApprover } from '../src/wallet/approver.js';
import {
  AccountId,
  Client,
  Hbar,
  TransactionId,
  TransferTransaction,
  TopicMessageSubmitTransaction,
  ContractExecuteTransaction,
  ScheduleCreateTransaction,
  type Transaction,
} from '@hiero-ledger/sdk';

/**
 * Builds frozen transactions offline, the same way the agent kit's RETURN_BYTES strategy
 * does: fix the transaction id, then freeze against a network-only client. No operator key
 * and no network calls are involved — which is exactly why the service can build
 * transactions while holding no Hedera account of its own.
 */

let client: Client | undefined;

/**
 * The one network-config client the tests share. Exported because tests that exercise freezing
 * should freeze against the SAME instance the fixtures use — building a second `Client.forTestnet()`
 * per case is both wasteful and an avoidable inconsistency in tests specifically about freezing.
 */
export function freezeClient(): Client {
  if (!client) client = Client.forTestnet();
  return client;
}

export function freeze<T extends Transaction>(transaction: T, payer: string): T {
  return transaction
    .setTransactionId(TransactionId.generate(AccountId.fromString(payer)))
    .freezeWith(freezeClient());
}

/** The unfrozen half of {@link hbarTransfer} — hooks and strategies run BEFORE freeze. */
export function unfrozenHbarTransfer(payer: string, to: string, amount = 5): TransferTransaction {
  return new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(payer), new Hbar(amount).negated())
    .addHbarTransfer(AccountId.fromString(to), new Hbar(amount));
}

export function hbarTransfer(payer: string, to: string, amount = 5): Transaction {
  return freeze(unfrozenHbarTransfer(payer, to, amount), payer);
}

export function topicMessage(payer: string): Transaction {
  return freeze(
    new TopicMessageSubmitTransaction().setTopicId('0.0.1234').setMessage('hello'),
    payer,
  );
}

export function contractCall(payer: string): Transaction {
  return freeze(
    new ContractExecuteTransaction().setContractId('0.0.5678').setGas(100_000),
    payer,
  );
}

/** An HBAR transfer that debits `owner` via allowance, wrapped in a schedule (like the kit's isScheduled path). */
export function scheduledForeignTransfer(payer: string, owner: string, to: string, amount = 5): Transaction {
  const inner = new TransferTransaction()
    .addApprovedHbarTransfer(AccountId.fromString(owner), new Hbar(amount).negated())
    .addHbarTransfer(AccountId.fromString(to), new Hbar(amount));
  return freeze(new ScheduleCreateTransaction().setScheduledTransaction(inner), payer);
}

export function toHex(transaction: Transaction): string {
  return Buffer.from(transaction.toBytes()).toString('hex');
}

export function toBase64(transaction: Transaction): string {
  return Buffer.from(transaction.toBytes()).toString('base64');
}

/**
 * A wallet that accepts everything but never settles, so `registry.submit` stays at
 * `awaiting_approval`. Shared because the `as unknown as WalletApprover` cast reaches past the
 * real interface — repeating it per file means a change to `WalletApprover` surfaces in none
 * of them.
 */
export function idleApprover(): WalletApprover {
  return { signAndExecute: () => new Promise<never>(() => {}) } as unknown as WalletApprover;
}

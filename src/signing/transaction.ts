import {
  Transaction,
  TransferTransaction,
  Hbar,
  ScheduleCreateTransaction,
  TopicMessageSubmitTransaction,
  TopicCreateTransaction,
  TokenAssociateTransaction,
  TokenCreateTransaction,
  TokenMintTransaction,
  AccountCreateTransaction,
  AccountDeleteTransaction,
  ContractExecuteTransaction,
  ContractCreateTransaction,
  EthereumTransaction,
  FileCreateTransaction,
  FileAppendTransaction,
} from '@hiero-ledger/sdk';

/**
 * The transaction whose effect actually matters, unwrapping a schedule.
 *
 * The agent kit's write tools accept `schedulingParams`, and `isScheduled: true` wraps the
 * built transaction in a `ScheduleCreateTransaction`. Our checks must see through that
 * wrapper — otherwise a foreign-debit transfer smuggled inside a schedule would bypass
 * assertNoForeignDebits (which keys off `instanceof TransferTransaction`).
 */
export function effectiveTransaction(transaction: Transaction): Transaction {
  if (transaction instanceof ScheduleCreateTransaction) {
    const inner = (transaction as unknown as { _scheduledTransaction?: Transaction })
      ._scheduledTransaction;
    if (inner instanceof Transaction) return inner;
  }
  return transaction;
}

/**
 * Inspection of the bytes an agent hands to `sign_with_wallet`.
 *
 * Those bytes made a round trip through the model's context, so nothing about them is
 * trusted. Two checks matter before anything reaches a wallet:
 *
 *  - the payer must be the paired account (the sender is never a tool parameter);
 *  - the caller must be told when a wallet cannot fully decode what it is being asked to
 *    sign, rather than having that gap quietly hidden.
 */

export class PayerMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `Transaction payer ${actual} is not the paired account ${expected}. ` +
        'The signing account is fixed by your wallet session and cannot be overridden.',
    );
    this.name = 'PayerMismatchError';
  }
}

export class UndecodableTransactionError extends Error {
  constructor(cause: string) {
    super(`Could not decode transaction bytes: ${cause}`);
    this.name = 'UndecodableTransactionError';
  }
}

export function decodeTransaction(base64OrHex: string): Transaction {
  const trimmed = base64OrHex.trim();
  let bytes: Buffer;
  try {
    // Agent-kit tools return hex; WalletConnect speaks base64. Accept either, since which
    // one the model relays is not something we control.
    bytes = /^[0-9a-fA-F]+$/.test(trimmed)
      ? Buffer.from(trimmed, 'hex')
      : Buffer.from(trimmed, 'base64');
  } catch (error) {
    throw new UndecodableTransactionError(error instanceof Error ? error.message : String(error));
  }
  if (bytes.length === 0) throw new UndecodableTransactionError('empty payload');

  try {
    return Transaction.fromBytes(bytes);
  } catch (error) {
    throw new UndecodableTransactionError(error instanceof Error ? error.message : String(error));
  }
}

/** The payer, taken from the frozen transaction id. */
export function payerOf(transaction: Transaction): string | undefined {
  return transaction.transactionId?.accountId?.toString();
}

export function assertPayerIs(transaction: Transaction, expectedAccountId: string): void {
  const payer = payerOf(transaction);
  if (!payer) throw new UndecodableTransactionError('transaction has no payer account');
  if (payer !== expectedAccountId) throw new PayerMismatchError(expectedAccountId, payer);
}

export class ForeignDebitError extends Error {
  constructor(debited: string, expected: string) {
    super(
      `Transaction debits ${debited}, which is not the paired account ${expected}. ` +
        'This service only signs transactions that spend from your own account.',
    );
    this.name = 'ForeignDebitError';
  }
}

/**
 * Rejects any transfer that debits an account other than the paired one.
 *
 * {@link assertPayerIs} only checks who pays the fee. An allowance transfer
 * (`transfer_hbar_with_allowance`, `transfer_fungible_token_with_allowance`) can name a
 * different `sourceAccountId` as the debited party while the paired account merely pays the
 * fee — so the payer check passes but someone else's balance moves. The sender is always the
 * paired account, so a foreign debit is refused before it ever reaches the wallet.
 * (Allowance-based spending from other accounts is not supported.)
 *
 * Covers HBAR and fungible-token legs. NFT sender-side debits are not checked here; an NFT
 * allowance transfer would still be caught by the wallet display.
 */
export function assertNoForeignDebits(transaction: Transaction, expectedAccountId: string): void {
  // Look through a schedule wrapper — the debit lives in the inner scheduled transfer.
  const effective = effectiveTransaction(transaction);
  if (!(effective instanceof TransferTransaction)) return;

  for (const leg of effective.hbarTransfersList) {
    if (leg.amount.toTinybars().isNegative() && leg.accountId.toString() !== expectedAccountId) {
      throw new ForeignDebitError(leg.accountId.toString(), expectedAccountId);
    }
  }

  for (const [, accountAmounts] of effective.tokenTransfers) {
    for (const [accountId, amount] of accountAmounts) {
      if (amount.isNegative() && accountId.toString() !== expectedAccountId) {
        throw new ForeignDebitError(accountId.toString(), expectedAccountId);
      }
    }
  }
}

export class InvalidTransferError extends Error {
  constructor(reason: string) {
    super(`Refusing to sign: ${reason}.`);
    this.name = 'InvalidTransferError';
  }
}

/**
 * Rejects economically-meaningless HBAR transfers before they reach the wallet:
 * an empty transfer (all legs net to zero / nothing credited) or one that only pays itself.
 * These build valid bytes but move nothing — failing fast is clearer than a wallet prompt for
 * a no-op. Bounded to HBAR transfers we can read; the wallet remains the final check.
 */
export function assertMeaningfulTransfer(transaction: Transaction, expectedAccountId: string): void {
  const effective = effectiveTransaction(transaction);
  if (!(effective instanceof TransferTransaction)) return;

  const legs = effective.hbarTransfersList;
  if (legs.length === 0) return; // not an HBAR transfer (e.g. token-only) — nothing to assert

  const credits = legs.filter(leg => !leg.amount.toTinybars().isNegative() && !leg.amount.toTinybars().isZero());
  if (credits.length === 0) {
    throw new InvalidTransferError('the transfer credits no account (zero or empty amount)');
  }
  if (credits.every(leg => leg.accountId.toString() === expectedAccountId)) {
    throw new InvalidTransferError('the transfer only moves funds to your own account');
  }
}

/**
 * The ONLY transaction types a wallet is trusted to render faithfully for the user, so the
 * wallet screen serves as the user's independent check.
 *
 * This is an ALLOWLIST, not a denylist, and that direction is deliberate: anything not
 * explicitly known-renderable — a schedule wrapper, an account delete that sweeps the
 * balance, a schedule-sign that shows only a scheduleId, a contract call, or any future
 * type — is treated as NOT verifiable, so the agent is warned and a caution memo is stamped.
 * A denylist fails open (an unlisted dangerous type reads as "safe"); an allowlist fails
 * closed. Matched with `instanceof`, never `constructor.name` (the SDK ships minified).
 */
const VERIFIABLE_TYPES = [
  TransferTransaction,
  TopicMessageSubmitTransaction,
  TopicCreateTransaction,
  TokenAssociateTransaction,
] as const;

/** Human-facing type labels, most specific first. Naming is independent of verifiability. */
const KNOWN_TYPES: [abstract new (...args: never[]) => Transaction, string][] = [
  [TransferTransaction, 'Transfer'],
  [TopicMessageSubmitTransaction, 'TopicMessageSubmit'],
  [TopicCreateTransaction, 'TopicCreate'],
  [TokenAssociateTransaction, 'TokenAssociate'],
  [TokenCreateTransaction, 'TokenCreate'],
  [TokenMintTransaction, 'TokenMint'],
  [AccountCreateTransaction, 'AccountCreate'],
  [AccountDeleteTransaction, 'AccountDelete'],
  [ScheduleCreateTransaction, 'ScheduleCreate'],
  [ContractExecuteTransaction, 'ContractExecute'],
  [ContractCreateTransaction, 'ContractCreate'],
  [EthereumTransaction, 'Ethereum'],
  [FileCreateTransaction, 'FileCreate'],
  [FileAppendTransaction, 'FileAppend'],
];

/**
 * Whether a wallet can meaningfully decode and display this transaction to the user.
 *
 * Checks the OUTER type: a schedule wrapping a transfer is still shown to the user as a
 * schedule, which the wallet does not render as its effect — so it is not verifiable even
 * though the inner transfer would be.
 */
export function isWalletVerifiable(transaction: Transaction): boolean {
  return VERIFIABLE_TYPES.some(type => transaction instanceof type);
}

export function transactionKind(transaction: Transaction): string {
  return KNOWN_TYPES.find(([type]) => transaction instanceof type)?.[1] ?? 'Transaction';
}

/**
 * A one-line description the agent should echo before the user reaches for their wallet.
 * Best-effort: it summarises what we can read, and never claims more than that.
 */
export function summarise(transaction: Transaction): string {
  // A schedule hides its real effect behind a wrapper — describe the inner transaction and
  // flag that it is scheduled, so the echoed summary reflects what actually moves.
  if (transaction instanceof ScheduleCreateTransaction) {
    const inner = effectiveTransaction(transaction);
    return inner === transaction ? 'ScheduleCreate' : `Scheduled: ${summarise(inner)}`;
  }

  const kind = transactionKind(transaction);

  if (transaction instanceof TransferTransaction) {
    const movements: string[] = [];
    for (const [account, amount] of transaction.hbarTransfers ?? new Map<unknown, Hbar>()) {
      const value = amount.toString();
      if (!value.startsWith('-')) movements.push(`${account} receives ${value}`);
    }
    if (movements.length) return `Transfer — ${movements.join(', ')}`;
  }

  const memo = transaction.transactionMemo;
  return memo ? `${kind} — memo: ${memo}` : kind;
}

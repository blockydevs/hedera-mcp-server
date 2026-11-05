import { describe, it, expect } from 'vitest';
import {
  decodeTransaction,
  assertPayerIs,
  payerOf,
  isWalletVerifiable,
  summarise,
  PayerMismatchError,
  UndecodableTransactionError,
} from '../src/signing/transaction.js';
import { hbarTransfer, topicMessage, contractCall, toHex, toBase64 } from './helpers.js';

const PAYER = '0.0.1001';
const OTHER = '0.0.2002';
const RECIPIENT = '0.0.3003';

describe('decodeTransaction', () => {
  it('accepts hex, which is what the agent kit write tools return', () => {
    const decoded = decodeTransaction(toHex(hbarTransfer(PAYER, RECIPIENT)));
    expect(payerOf(decoded)).toBe(PAYER);
  });

  it('accepts base64, which is what WalletConnect speaks', () => {
    const decoded = decodeTransaction(toBase64(hbarTransfer(PAYER, RECIPIENT)));
    expect(payerOf(decoded)).toBe(PAYER);
  });

  it('rejects an empty payload', () => {
    expect(() => decodeTransaction('')).toThrow(UndecodableTransactionError);
  });

  it('rejects garbage rather than passing it to a wallet', () => {
    expect(() => decodeTransaction('not-a-transaction!!')).toThrow(UndecodableTransactionError);
  });

  it('rejects bytes truncated in transit — the realistic corruption when a model relays them', () => {
    const full = toHex(hbarTransfer(PAYER, RECIPIENT));
    expect(() => decodeTransaction(full.slice(0, Math.floor(full.length / 2)))).toThrow(
      UndecodableTransactionError,
    );
  });
});

describe('assertPayerIs', () => {
  it('passes when the payer is the paired account', () => {
    const transaction = decodeTransaction(toHex(hbarTransfer(PAYER, RECIPIENT)));
    expect(() => assertPayerIs(transaction, PAYER)).not.toThrow();
  });

  // The core confused-deputy guard: bytes reach us via the model, so a transaction
  // drawing on someone else's account must never be forwarded to a wallet.
  it('rejects a transaction that would spend from another account', () => {
    const transaction = decodeTransaction(toHex(hbarTransfer(OTHER, RECIPIENT)));
    expect(() => assertPayerIs(transaction, PAYER)).toThrow(PayerMismatchError);
  });

  it('names both accounts so the agent can explain the refusal', () => {
    const transaction = decodeTransaction(toHex(hbarTransfer(OTHER, RECIPIENT)));
    try {
      assertPayerIs(transaction, PAYER);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain(OTHER);
      expect((error as Error).message).toContain(PAYER);
    }
  });
});

describe('isWalletVerifiable', () => {
  it('marks transfers verifiable — a wallet renders them faithfully', () => {
    expect(isWalletVerifiable(hbarTransfer(PAYER, RECIPIENT))).toBe(true);
  });

  it('marks topic messages verifiable', () => {
    expect(isWalletVerifiable(topicMessage(PAYER))).toBe(true);
  });

  // The gap is stated, not hidden.
  it('marks contract calls NOT verifiable', () => {
    expect(isWalletVerifiable(contractCall(PAYER))).toBe(false);
  });
});

describe('summarise', () => {
  it('describes a transfer in terms the user can check against their wallet', () => {
    const summary = summarise(hbarTransfer(PAYER, RECIPIENT));
    expect(summary).toContain('Transfer');
    expect(summary).toContain(RECIPIENT);
  });

  it('falls back to the transaction type for other kinds', () => {
    expect(summarise(contractCall(PAYER))).toContain('ContractExecute');
  });
});

import { TransferTransaction, AccountId, Hbar, TokenId } from '@hiero-ledger/sdk';
import { assertNoForeignDebits, ForeignDebitError } from '../src/signing/transaction.js';
import { freeze } from './helpers.js';

const PAIRED = '0.0.1001';

describe('assertNoForeignDebits', () => {
  it('allows a transfer that debits the paired account', () => {
    const tx = hbarTransfer(PAIRED, '0.0.2002', 5); // debits PAIRED
    expect(() => assertNoForeignDebits(tx, PAIRED)).not.toThrow();
  });

  // The allowance hole: payer is the paired account, but the debit is a third party.
  it('rejects an HBAR transfer that debits another account', () => {
    const tx = freeze(
      new TransferTransaction()
        .addApprovedHbarTransfer(AccountId.fromString('0.0.9999'), new Hbar(5).negated())
        .addHbarTransfer(AccountId.fromString('0.0.2002'), new Hbar(5)),
      PAIRED, // paired account is only the fee payer
    );
    expect(() => assertNoForeignDebits(tx, PAIRED)).toThrow(ForeignDebitError);
  });

  it('rejects a fungible-token transfer that debits another account', () => {
    const tx = freeze(
      new TransferTransaction()
        .addApprovedTokenTransfer(TokenId.fromString('0.0.5000'), AccountId.fromString('0.0.9999'), -10)
        .addTokenTransfer(TokenId.fromString('0.0.5000'), AccountId.fromString('0.0.2002'), 10),
      PAIRED,
    );
    expect(() => assertNoForeignDebits(tx, PAIRED)).toThrow(ForeignDebitError);
  });

  it('names the debited account in the error', () => {
    const tx = freeze(
      new TransferTransaction()
        .addApprovedHbarTransfer(AccountId.fromString('0.0.9999'), new Hbar(1).negated())
        .addHbarTransfer(AccountId.fromString('0.0.2002'), new Hbar(1)),
      PAIRED,
    );
    try {
      assertNoForeignDebits(tx, PAIRED);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('0.0.9999');
    }
  });

  it('ignores non-transfer transactions', () => {
    expect(() => assertNoForeignDebits(contractCall(PAIRED), PAIRED)).not.toThrow();
  });
});

import {
  effectiveTransaction,
  isWalletVerifiable as isVerifiable2,
} from '../src/signing/transaction.js';
import { scheduledForeignTransfer, toHex as toHex2 } from './helpers.js';
import { AccountDeleteTransaction, TransferTransaction as TT2, AccountId as AID2, Hbar as Hbar2, ScheduleCreateTransaction as SCT } from '@hiero-ledger/sdk';

describe('scheduled-transaction bypass (H2)', () => {
  // The headline security fix: an allowance transfer smuggled inside a schedule must NOT
  // slip past the foreign-debit guard.
  it('catches a foreign debit wrapped in a ScheduleCreate', () => {
    const scheduled = scheduledForeignTransfer('0.0.1001', '0.0.9999', '0.0.2002', 5);
    expect(() => assertNoForeignDebits(scheduled, '0.0.1001')).toThrow(ForeignDebitError);
  });

  it('still catches it after a bytes round-trip (decoded schedule)', () => {
    const scheduled = scheduledForeignTransfer('0.0.1001', '0.0.9999', '0.0.2002', 5);
    const decoded = decodeTransaction(toHex2(scheduled));
    expect(() => assertNoForeignDebits(decoded, '0.0.1001')).toThrow(ForeignDebitError);
  });

  it('allows a scheduled transfer that debits the paired account itself', () => {
    const inner = new TT2()
      .addHbarTransfer(AID2.fromString('0.0.1001'), new Hbar2(5).negated())
      .addHbarTransfer(AID2.fromString('0.0.2002'), new Hbar2(5));
    const scheduled = freeze(new SCT().setScheduledTransaction(inner), '0.0.1001');
    expect(() => assertNoForeignDebits(scheduled, '0.0.1001')).not.toThrow();
  });

  it('effectiveTransaction unwraps the inner scheduled transaction', () => {
    const scheduled = scheduledForeignTransfer('0.0.1001', '0.0.9999', '0.0.2002');
    expect(effectiveTransaction(scheduled)).toBeInstanceOf(TT2);
  });

  it('summarises a scheduled transfer as scheduled', () => {
    const scheduled = scheduledForeignTransfer('0.0.1001', '0.0.9999', '0.0.2002');
    expect(summarise(scheduled)).toContain('Scheduled');
  });
});

describe('isWalletVerifiable is an allowlist (M2, fails closed)', () => {
  it('marks a schedule NOT verifiable even when it wraps a transfer', () => {
    expect(isVerifiable2(scheduledForeignTransfer('0.0.1001', '0.0.9999', '0.0.2002'))).toBe(false);
  });

  it('marks an account delete NOT verifiable (it sweeps the whole balance)', () => {
    const del = freeze(
      new AccountDeleteTransaction()
        .setAccountId(AID2.fromString('0.0.1001'))
        .setTransferAccountId(AID2.fromString('0.0.2002')),
      '0.0.1001',
    );
    expect(isVerifiable2(del)).toBe(false);
  });
});

import { assertMeaningfulTransfer, InvalidTransferError } from '../src/signing/transaction.js';
import { TransferTransaction as TT3, AccountId as AID3, Hbar as Hbar3 } from '@hiero-ledger/sdk';

describe('assertMeaningfulTransfer', () => {
  it('allows a normal transfer to another account', () => {
    expect(() => assertMeaningfulTransfer(hbarTransfer('0.0.1001', '0.0.2002', 5), '0.0.1001')).not.toThrow();
  });
  it('rejects a self-only transfer', () => {
    // credit leg goes back to the owner
    const tx = freeze(
      new TT3()
        .addHbarTransfer(AID3.fromString('0.0.1001'), new Hbar3(5).negated())
        .addHbarTransfer(AID3.fromString('0.0.1001'), new Hbar3(5)),
      '0.0.1001',
    );
    expect(() => assertMeaningfulTransfer(tx, '0.0.1001')).toThrow(InvalidTransferError);
  });
  it('ignores non-HBAR transactions', () => {
    expect(() => assertMeaningfulTransfer(contractCall('0.0.1001'), '0.0.1001')).not.toThrow();
  });
});

describe('assertMeaningfulTransfer — zero/empty credit branch', () => {
  it('rejects a transfer that credits no account', () => {
    // only a debit leg, no positive credit
    const tx = freeze(
      new TT3().addHbarTransfer(AID3.fromString('0.0.1001'), new Hbar3(0)),
      '0.0.1001',
    );
    expect(() => assertMeaningfulTransfer(tx, '0.0.1001')).toThrow(InvalidTransferError);
  });
});

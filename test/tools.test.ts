import { describe, it, expect } from 'vitest';
import { buildApprovalResponse } from '../src/signing/tools.js';
import { SigningRequestRegistry } from '../src/signing/requests.js';
import { IntentRegistry, fingerprintTransaction } from '../src/signing/intent.js';
import { PayerMismatchError, ForeignDebitError } from '../src/signing/transaction.js';
import type { WalletApprover } from '../src/wallet/approver.js';
import { TransferTransaction, AccountId, Hbar } from '@hiero-ledger/sdk';
import { hbarTransfer, freeze } from './helpers.js';

const PAIRED = '0.0.1001';
const CTX = { accountId: PAIRED, topic: 'topic-a', network: 'testnet' };

function registry(): { reg: SigningRequestRegistry; delivered: () => boolean } {
  let didDeliver = false;
  const approver = {
    signAndExecute: async () => {
      didDeliver = true;
      return new Promise<{ transactionId: string }>(() => {}); // stays awaiting
    },
  } as unknown as WalletApprover;
  return { reg: new SigningRequestRegistry(approver, 60_000), delivered: () => didDeliver };
}

describe('buildApprovalResponse', () => {
  // This is the core the two-step gap was closed with: one call builds AND delivers.
  it('delivers the transaction and returns a requestId envelope', () => {
    const { reg, delivered } = registry();
    const response = buildApprovalResponse(hbarTransfer(PAIRED, '0.0.2002', 5), CTX, reg);
    expect(response.requestId).toBeTruthy();
    expect(response.status).toBe('awaiting_approval');
    expect(response.summary).toContain('Transfer');
    expect(response.walletVerifiable).toBe(true);
    expect(delivered()).toBe(true);
  });

  it('prefers the summary captured at build time by the hook', () => {
    const { reg } = registry();
    const intents = new IntentRegistry(60_000);
    const tx = hbarTransfer(PAIRED, '0.0.2002', 5);
    intents.record(fingerprintTransaction(tx), {
      toolMethod: 'transfer_hbar_tool',
      txKind: 'Transfer',
      summary: 'Send 5 HBAR to Bob',
      walletVerifiable: true,
      memo: '',
      normalisedParams: {},
      capturedAt: Date.now(),
    });
    expect(buildApprovalResponse(tx, CTX, reg, intents).summary).toBe('Send 5 HBAR to Bob');
  });

  it('rejects (and does not deliver) a transaction paid by another account', () => {
    const { reg, delivered } = registry();
    const foreign = hbarTransfer('0.0.9999', '0.0.2002', 5); // payer 0.0.9999
    expect(() => buildApprovalResponse(foreign, CTX, reg)).toThrow(PayerMismatchError);
    expect(delivered()).toBe(false);
  });

  it('rejects (and does not deliver) an allowance transfer that debits a third party', () => {
    const { reg, delivered } = registry();
    const tx = freeze(
      new TransferTransaction()
        .addApprovedHbarTransfer(AccountId.fromString('0.0.9999'), new Hbar(5).negated())
        .addHbarTransfer(AccountId.fromString('0.0.2002'), new Hbar(5)),
      PAIRED, // paired account is only the fee payer
    );
    expect(() => buildApprovalResponse(tx, CTX, reg)).toThrow(ForeignDebitError);
    expect(delivered()).toBe(false);
  });
});

import { TooManyApprovalsError } from '../src/signing/tools.js';

describe('per-account approval quota', () => {
  // A default of 3 concurrent pending approvals; the 4th must be refused, not delivered.
  it('refuses a new approval once the per-account cap is reached', () => {
    const { reg, delivered } = registry();
    const ctx = CTX;
    // Fill to the cap (default 3) with live (never-settling) approvals.
    for (let i = 0; i < 3; i++) buildApprovalResponse(hbarTransfer(PAIRED, `0.0.${2000 + i}`, 1), ctx, reg);
    const before = delivered();
    expect(() => buildApprovalResponse(hbarTransfer(PAIRED, '0.0.2999', 1), ctx, reg)).toThrow(
      TooManyApprovalsError,
    );
    // The refused one was never delivered to the wallet.
    expect(delivered()).toBe(before);
  });

  it('does not count another account against your cap', () => {
    const { reg } = registry();
    for (let i = 0; i < 3; i++) buildApprovalResponse(hbarTransfer(PAIRED, `0.0.${2000 + i}`, 1), CTX, reg);
    const other = { accountId: '0.0.9999', topic: 'topic-b', network: 'testnet' };
    // A different account is unaffected by PAIRED's pending approvals.
    expect(() => buildApprovalResponse(hbarTransfer('0.0.9999', '0.0.2002', 1), other, reg)).not.toThrow();
  });
});

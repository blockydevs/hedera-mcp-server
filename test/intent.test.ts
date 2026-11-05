import { describe, it, expect } from 'vitest';
import { TransferTransaction, ContractExecuteTransaction, AccountId, Hbar } from '@hiero-ledger/sdk';
import { IntentRegistry, fingerprintTransaction, type CapturedIntent } from '../src/signing/intent.js';
import { hbarTransfer } from './helpers.js';

function intent(over: Partial<CapturedIntent> = {}): CapturedIntent {
  return {
    toolMethod: 'transfer_hbar_tool',
    txKind: 'Transfer',
    summary: 'Transfer — 0.0.2002 receives 5 ℏ',
    walletVerifiable: true,
    memo: '',
    normalisedParams: { transfers: [] },
    capturedAt: Date.now(),
    ...over,
  };
}

describe('fingerprintTransaction', () => {
  // The load-bearing property for cross-call matching: the hook fingerprints an UNFROZEN
  // transaction, sign_with_wallet fingerprints the FROZEN bytes, and they must agree — the
  // fields it hashes are exactly the ones freezing leaves untouched.
  it('is stable across freezing', () => {
    const unfrozen = new TransferTransaction()
      .addHbarTransfer(AccountId.fromString('0.0.1001'), new Hbar(5).negated())
      .addHbarTransfer(AccountId.fromString('0.0.2002'), new Hbar(5));
    const before = fingerprintTransaction(unfrozen);
    const after = fingerprintTransaction(hbarTransfer('0.0.1001', '0.0.2002', 5));
    expect(before).toBe(after);
  });

  it('differs when the recipient differs', () => {
    expect(fingerprintTransaction(hbarTransfer('0.0.1001', '0.0.2002', 5))).not.toBe(
      fingerprintTransaction(hbarTransfer('0.0.1001', '0.0.3003', 5)),
    );
  });

  it('differs when the amount differs', () => {
    expect(fingerprintTransaction(hbarTransfer('0.0.1001', '0.0.2002', 5))).not.toBe(
      fingerprintTransaction(hbarTransfer('0.0.1001', '0.0.2002', 6)),
    );
  });

  it('differs when the memo differs (memo is part of the key)', () => {
    const a = new ContractExecuteTransaction().setContractId('0.0.5678').setGas(100_000);
    const b = new ContractExecuteTransaction().setContractId('0.0.5678').setGas(100_000);
    b.setTransactionMemo('stamped');
    expect(fingerprintTransaction(a)).not.toBe(fingerprintTransaction(b));
  });

  it('never throws, even on a bare transaction', () => {
    expect(() => fingerprintTransaction(new ContractExecuteTransaction())).not.toThrow();
  });
});

describe('IntentRegistry', () => {
  it('round-trips a captured intent by fingerprint', () => {
    const registry = new IntentRegistry(60_000);
    const fp = fingerprintTransaction(hbarTransfer('0.0.1001', '0.0.2002', 5));
    registry.record(fp, intent());
    expect(registry.get(fp)?.summary).toContain('Transfer');
  });

  it('returns undefined for an unknown fingerprint', () => {
    expect(new IntentRegistry(60_000).get('deadbeef')).toBeUndefined();
  });

  it('does not consume on read — get is idempotent so re-issue can reuse it later', () => {
    const registry = new IntentRegistry(60_000);
    const fp = 'fp1';
    registry.record(fp, intent());
    expect(registry.get(fp)).toBeDefined();
    expect(registry.get(fp)).toBeDefined();
  });

  it('treats an intent past its TTL as absent', () => {
    const registry = new IntentRegistry(1_000);
    const now = Date.now();
    registry.record('fp', intent({ capturedAt: now }));
    expect(registry.get('fp', now + 1_001)).toBeUndefined();
  });

  it('prunes expired intents so an unmatched build cannot grow the map', () => {
    const registry = new IntentRegistry(1_000);
    const now = Date.now();
    registry.record('a', intent({ capturedAt: now }));
    registry.record('b', intent({ capturedAt: now }));
    expect(registry.size).toBe(2);
    registry.prune(now + 1_001);
    expect(registry.size).toBe(0);
  });

  it('retains the normalised params (the input a server-side re-issue would need)', () => {
    const registry = new IntentRegistry(60_000);
    registry.record('fp', intent({ normalisedParams: { transfers: [{ accountId: '0.0.2002' }] } }));
    expect(registry.get('fp')?.normalisedParams).toEqual({ transfers: [{ accountId: '0.0.2002' }] });
  });
});

import { TokenId as TID } from '@hiero-ledger/sdk';
import { freeze as freeze2 } from './helpers.js';

describe('fingerprint includes token legs (L2)', () => {
  const tokenTransfer = (owner: string, to: string, amt: number) =>
    freeze2(
      new TransferTransaction()
        .addApprovedTokenTransfer(TID.fromString('0.0.5000'), AccountId.fromString(owner), -amt)
        .addTokenTransfer(TID.fromString('0.0.5000'), AccountId.fromString(to), amt),
      owner,
    );

  it('distinguishes two token transfers that share an (empty) memo', () => {
    const a = tokenTransfer('0.0.1001', '0.0.2002', 10);
    const b = tokenTransfer('0.0.1001', '0.0.3003', 20);
    expect(fingerprintTransaction(a)).not.toBe(fingerprintTransaction(b));
  });
});

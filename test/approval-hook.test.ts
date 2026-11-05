import { describe, it, expect } from 'vitest';
import {
  TransferTransaction,
  ContractExecuteTransaction,
  AccountId,
  Hbar,
} from '@hiero-ledger/sdk';
import { AgentMode, type Context } from '@hashgraph/hedera-agent-kit';
import * as plugin from '@hashgraph/hedera-agent-kit/plugins';
import { WalletApprovalHook, WRITE_TOOL_METHODS } from '../src/signing/approval-hook.js';
import { IntentRegistry, fingerprintTransaction } from '../src/signing/intent.js';
import { hbarTransfer } from './helpers.js';

// Unfrozen builders — the hook runs before freeze, so tests must hand it mutable transactions.
function unfrozenTransfer() {
  return new TransferTransaction()
    .addHbarTransfer(AccountId.fromString('0.0.1001'), new Hbar(5).negated())
    .addHbarTransfer(AccountId.fromString('0.0.2002'), new Hbar(5));
}
function unfrozenContractCall() {
  return new ContractExecuteTransaction().setContractId('0.0.5678').setGas(100_000);
}

function newHook() {
  const intents = new IntentRegistry(60_000);
  return { hook: new WalletApprovalHook(intents), intents };
}

describe('WRITE_TOOL_METHODS', () => {
  it('includes the write tools and excludes query tools', () => {
    expect(WRITE_TOOL_METHODS).toContain('transfer_hbar_tool');
    expect(WRITE_TOOL_METHODS).toContain('create_erc20_tool');
    expect(WRITE_TOOL_METHODS).toContain('submit_topic_message_tool');
    expect(WRITE_TOOL_METHODS).not.toContain('get_hbar_balance_query_tool');
  });

  // Added by agent-kit 4.1.0. The list is derived from the kit's own tool-name maps, so a new
  // write tool is auto-admitted on upgrade — pin it explicitly so its arrival is a reviewed
  // fact rather than a silent one, and so its disappearance would fail loudly.
  it('covers transfer_fungible_token_tool (new in agent-kit 4.1.0)', () => {
    expect(WRITE_TOOL_METHODS).toContain('transfer_fungible_token_tool');
  });

  /**
   * Two independent things must agree: WRITE_TOOL_METHODS decides which tools get the
   * wallet-flow DESCRIPTION, while the delivery strategy fires for every tool the kit marks as
   * a transaction. If those sets ever diverge, a tool would silently deliver to the user's
   * wallet while its description still tells the model it returns bytes to sign elsewhere.
   */
  it('matches exactly the kit tools typed as transactions', () => {
    const context: Context = { mode: AgentMode.RETURN_BYTES, accountId: '0.0.1001' };
    const plugins = [
      plugin.coreTokenPlugin, plugin.coreAccountPlugin, plugin.coreConsensusPlugin,
      plugin.coreEVMPlugin, plugin.coreAccountQueryPlugin, plugin.coreTokenQueryPlugin,
      plugin.coreConsensusQueryPlugin, plugin.coreEVMQueryPlugin,
      plugin.coreMiscQueriesPlugin, plugin.coreTransactionQueryPlugin,
    ];
    const transactional = plugins
      .flatMap(p => (p as { tools: (c: Context) => { method: string; toolType?: string }[] }).tools(context))
      .filter(t => t.toolType === 'transaction')
      .map(t => t.method);

    expect([...transactional].sort()).toEqual([...WRITE_TOOL_METHODS].sort());
  });
});

describe('WalletApprovalHook.postCoreActionHook', () => {
  // A wallet cannot decode a contract call, so the service MUST stamp a memo.
  it('stamps a memo on an opaque transaction that has none', async () => {
    const { hook } = newHook();
    const tx = unfrozenContractCall();
    await hook.postCoreActionHook({ coreActionResult: tx, normalisedParams: {} }, 'create_erc20_tool');
    expect(tx.transactionMemo.length).toBeGreaterThan(0);
    expect(tx.transactionMemo.length).toBeLessThanOrEqual(100);
  });

  it('does not stamp a memo on a verifiable transaction (the wallet renders it)', async () => {
    const { hook } = newHook();
    const tx = unfrozenTransfer();
    await hook.postCoreActionHook({ coreActionResult: tx, normalisedParams: {} }, 'transfer_hbar_tool');
    expect(tx.transactionMemo).toBe('');
  });

  // Respect the agent's intent: never clobber a memo it deliberately supplied.
  it('preserves an existing memo rather than overwriting it', async () => {
    const { hook } = newHook();
    const tx = unfrozenContractCall();
    tx.setTransactionMemo('agent-supplied note');
    await hook.postCoreActionHook({ coreActionResult: tx, normalisedParams: {} }, 'create_erc20_tool');
    expect(tx.transactionMemo).toBe('agent-supplied note');
  });

  it('records intent retrievable by the transaction fingerprint', async () => {
    const { hook, intents } = newHook();
    const tx = unfrozenTransfer();
    await hook.postCoreActionHook(
      { coreActionResult: tx, normalisedParams: { transfers: [{ accountId: '0.0.2002' }] } },
      'transfer_hbar_tool',
    );
    const captured = intents.get(fingerprintTransaction(tx));
    expect(captured?.toolMethod).toBe('transfer_hbar_tool');
    expect(captured?.summary).toContain('Transfer');
    expect(captured?.walletVerifiable).toBe(true);
    expect(captured?.normalisedParams).toEqual({ transfers: [{ accountId: '0.0.2002' }] });
  });

  // The fingerprint recorded pre-freeze must match the one sign_with_wallet computes on the
  // frozen bytes — otherwise the summary would never be found.
  it('records under a fingerprint that survives freezing', async () => {
    const { hook, intents } = newHook();
    const tx = unfrozenTransfer();
    await hook.postCoreActionHook({ coreActionResult: tx, normalisedParams: {} }, 'transfer_hbar_tool');
    const frozenFingerprint = fingerprintTransaction(hbarTransfer('0.0.1001', '0.0.2002', 5));
    expect(intents.get(frozenFingerprint)).toBeDefined();
  });

  it('records the opaque memo it stamped, so the summary reflects it', async () => {
    const { hook, intents } = newHook();
    const tx = unfrozenContractCall();
    await hook.postCoreActionHook({ coreActionResult: tx, normalisedParams: {} }, 'create_erc20_tool');
    const captured = intents.get(fingerprintTransaction(tx));
    expect(captured?.walletVerifiable).toBe(false);
    expect(captured?.memo).toBe(tx.transactionMemo);
  });

  it('ignores tools it is not responsible for', async () => {
    const { hook, intents } = newHook();
    const tx = unfrozenTransfer();
    await hook.postCoreActionHook({ coreActionResult: tx, normalisedParams: {} }, 'get_hbar_balance_query_tool');
    expect(intents.size).toBe(0);
    expect(tx.transactionMemo).toBe('');
  });

  it('skips a non-transaction core result without throwing', async () => {
    const { hook, intents } = newHook();
    await expect(
      hook.postCoreActionHook({ coreActionResult: { not: 'a tx' }, normalisedParams: {} }, 'transfer_hbar_tool'),
    ).resolves.toBeUndefined();
    expect(intents.size).toBe(0);
  });

  // Mutating a frozen transaction would throw; the hook must skip it, not crash the write.
  it('skips an already-frozen transaction', async () => {
    const { hook, intents } = newHook();
    const frozen = hbarTransfer('0.0.1001', '0.0.2002', 5); // helpers.freeze() froze it
    await expect(
      hook.postCoreActionHook({ coreActionResult: frozen, normalisedParams: {} }, 'transfer_hbar_tool'),
    ).resolves.toBeUndefined();
    expect(intents.size).toBe(0);
  });
});

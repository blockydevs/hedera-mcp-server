import { describe, it, expect } from 'vitest';
import { Transaction, TransferTransaction } from '@hiero-ledger/sdk';
import { AgentMode, type Context } from '@hashgraph/hedera-agent-kit';
import { coreTokenPlugin } from '@hashgraph/hedera-agent-kit/plugins';
import { WalletDeliveryStrategy, isWalletDeliveryResult } from '../src/signing/wallet-strategy.js';
import { SigningRequestRegistry } from '../src/signing/requests.js';
import { IntentRegistry } from '../src/signing/intent.js';
import { WalletApprovalHook } from '../src/signing/approval-hook.js';
import { freezeClient, idleApprover, unfrozenHbarTransfer } from './helpers.js';

/**
 * Covers the delivery path end to end through `createSigningToolkit` / the delivery seam — the
 * path that decides whether a transaction reaches the wallet with the payer/debit/quota guards
 * applied, which the type checker alone cannot vouch for.
 */

const ACCOUNT = '0.0.1001';

function deps() {
  return {
    registry: new SigningRequestRegistry(idleApprover(), 60_000),
    intents: new IntentRegistry(60_000),
    walletContext: {
      accountId: ACCOUNT,
      topic: 'topic-a',
      network: 'testnet',
      sessionExpiry: Date.now() + 60_000,
    },
  };
}

function strategyFor() {
  // `deps()` already returns exactly WalletStrategyDeps, so it is passed straight through.
  const d = deps();
  return { d, strategy: new WalletDeliveryStrategy(d) };
}

const walletCtx = (over: Partial<Context> = {}): Context => ({
  mode: AgentMode.CUSTOM_RETURN_BYTES,
  accountId: ACCOUNT,
  ...over,
});

const unfrozenTransfer = (from = ACCOUNT, to = '0.0.2002') => unfrozenHbarTransfer(from, to);

describe('WalletDeliveryStrategy', () => {
  it('freezes the transaction and returns an approval envelope', async () => {
    const { strategy, d } = strategyFor();
    const tx = unfrozenTransfer();

    const result = await strategy.handle(tx, freezeClient(), walletCtx());

    expect(tx.isFrozen()).toBe(true);
    expect(result.approval?.requestId).toBeTruthy();
    expect(result.approval?.status).toBe('awaiting_approval');
    // The request really reached the registry — delivery happened, not just envelope-shaping.
    expect(d.registry.get(result.approval!.requestId)).toBeDefined();
  });

  // The kit's own contract for CUSTOM_RETURN_BYTES is `{ bytes }`; we return a superset so we
  // stay inside it rather than casting past it.
  it('still returns real frozen bytes, satisfying the kit contract', async () => {
    const { strategy } = strategyFor();
    const result = await strategy.handle(unfrozenTransfer(), freezeClient(), walletCtx());

    expect(result.bytes).toBeInstanceOf(Uint8Array);
    const reparsed = Transaction.fromBytes(Buffer.from(result.bytes));
    expect(reparsed).toBeInstanceOf(TransferTransaction);
  });

  // BaseTool.execute swallows throws into its own error envelope, so a guard rejection has to
  // come back as DATA we can discriminate — otherwise a refusal reads as a success.
  it('reports a guard rejection as a refusal instead of throwing', async () => {
    const { strategy, d } = strategyFor();
    // Debits an account that is not the paired one — assertNoForeignDebits must refuse.
    const foreign = unfrozenTransfer('0.0.9999', '0.0.2002');

    const result = await strategy.handle(foreign, freezeClient(), walletCtx());

    expect(result.approvalRefused).toMatch(/debits 0\.0\.9999.*not the paired account 0\.0\.1001/);
    expect(result.approval).toBeUndefined();
    expect(isWalletDeliveryResult(result)).toBe(true);
    // Nothing was delivered to the wallet.
    expect(d.registry.countAwaiting(ACCOUNT)).toBe(0);
  });

  // getStrategyFromContext hands the same strategy to BOTH custom modes; running an
  // approval-shaped strategy in an EXECUTING mode must be impossible.
  it('refuses to run in customExecuteTx mode', async () => {
    const { strategy } = strategyFor();
    await expect(
      strategy.handle(unfrozenTransfer(), freezeClient(), walletCtx({ mode: AgentMode.CUSTOM_EXECUTE_TX })),
    ).rejects.toThrow(/never executes transactions itself/);
  });

  it('refuses without an account in context', async () => {
    const { strategy } = strategyFor();
    await expect(
      strategy.handle(unfrozenTransfer(), freezeClient(), walletCtx({ accountId: undefined })),
    ).rejects.toThrow(/Account ID is required/);
  });
});

describe('WalletDeliveryStrategy inside the real tool pipeline', () => {
  it('makes a write tool deliver to the wallet instead of returning bytes', async () => {
    const d = deps();
    const context: Context = {
      mode: AgentMode.CUSTOM_RETURN_BYTES,
      accountId: ACCOUNT,
      hooks: [new WalletApprovalHook(d.intents)],
      transactionStrategy: new WalletDeliveryStrategy(d),
    };

    const tool: any = coreTokenPlugin
      .tools(context)
      .find((candidate: any) => candidate.method === 'associate_token_tool');
    const out = await tool.execute(freezeClient(), context, {
      accountId: ACCOUNT,
      tokenIds: ['0.0.5005'],
    });

    // The tool's own terminal step delivered it — no wrapper involvement.
    expect(isWalletDeliveryResult(out)).toBe(true);
    expect(out.approval?.requestId).toBeTruthy();
    expect(d.registry.get(out.approval.requestId)).toBeDefined();
  });
});

import { describe, it, expect } from 'vitest';
import { Client, Transaction } from '@hiero-ledger/sdk';
import { AgentMode, type Context } from '@hashgraph/hedera-agent-kit';
import { coreTokenPlugin, coreConsensusPlugin } from '@hashgraph/hedera-agent-kit/plugins';
import { WalletApprovalHook } from '../src/signing/approval-hook.js';
import { IntentRegistry, fingerprintTransaction } from '../src/signing/intent.js';

/**
 * End-to-end through the REAL agent-kit tool pipeline, not a synthetic Transaction.
 *
 * The rest of the hook suite calls `postCoreActionHook` directly, which cannot detect *when*
 * the kit fires it. That blind spot was real: through agent-kit 4.0.0 several tools performed
 * the freeze inside `coreAction`, so the hook received an already-frozen transaction and
 * silently stamped nothing — memo and intent were missing for exactly the opaque tool types
 * that need them most. 4.1.0 moved the freeze into `secondaryAction` for those tools.
 *
 * These tests assert the property we actually depend on: by the time the bytes come back, our
 * memo is on them. They run offline — RETURN_BYTES freezes locally and never submits.
 */

interface ExecutableTool {
  method: string;
  execute(client: Client, context: Context, params: unknown): Promise<{ bytes?: Uint8Array }>;
}

const ACCOUNT = '0.0.1001';

function toolByMethod(method: string, context: Context): ExecutableTool {
  const all = [...coreTokenPlugin.tools(context), ...coreConsensusPlugin.tools(context)];
  const tool = all.find(candidate => candidate.method === method);
  if (!tool) throw new Error(`tool ${method} not found in plugin`);
  return tool;
}

async function runTool(method: string, params: unknown) {
  const intents = new IntentRegistry(60_000);
  const context: Context = {
    mode: AgentMode.RETURN_BYTES,
    accountId: ACCOUNT,
    hooks: [new WalletApprovalHook(intents)],
  };
  const result = await toolByMethod(method, context).execute(Client.forTestnet(), context, params);
  return { result, intents };
}

describe('approval hook through the real tool pipeline', () => {
  // An opaque type the wallet cannot render: the memo is the user's only description of it,
  // and it can only be attached before freeze — so its presence in the bytes proves the
  // ordering. This is the case that was silently broken before agent-kit 4.1.0.
  it('stamps the memo and records intent for dissociate_token_tool', async () => {
    const { result, intents } = await runTool('dissociate_token_tool', {
      accountId: ACCOUNT,
      tokenIds: ['0.0.5005'],
    });

    expect(result.bytes).toBeInstanceOf(Uint8Array);
    const delivered = Transaction.fromBytes(Buffer.from(result.bytes!));
    expect(delivered.transactionMemo).toMatch(/Hedera MCP/);
    // Fingerprinting the DELIVERED bytes must find the intent recorded pre-freeze, proving
    // both sides hashed the same post-stamp memo.
    expect(intents.get(fingerprintTransaction(delivered))?.toolMethod).toBe('dissociate_token_tool');
  });

  // TokenAssociate IS wallet-verifiable (transaction.ts VERIFIABLE_TYPES), so a memo is
  // deliberately withheld — the wallet renders it. Intent recording still has to happen,
  // and it is what proves the hook ran here.
  it('records intent for associate_token_tool without stamping a memo', async () => {
    const { result, intents } = await runTool('associate_token_tool', {
      accountId: ACCOUNT,
      tokenIds: ['0.0.5005'],
    });

    // Fingerprinting the DELIVERED transaction must find the intent recorded pre-freeze —
    // proving both sides hashed the same post-stamp memo.
    const delivered = Transaction.fromBytes(Buffer.from(result.bytes!));
    const intent = intents.get(fingerprintTransaction(delivered));
    expect(intent).toBeDefined();
    expect(intent!.toolMethod).toBe('associate_token_tool');
    expect(delivered.transactionMemo).toBe(''); // verifiable type — memo withheld on purpose
  });

  // A verifiable type renders itself in the wallet, so it must be left alone even here.
  it('leaves a wallet-verifiable transaction unstamped', async () => {
    const { result } = await runTool('submit_topic_message_tool', {
      topicId: '0.0.7007',
      message: 'hello',
    });
    const delivered = Transaction.fromBytes(Buffer.from(result.bytes!));
    expect(delivered.transactionMemo).toBe('');
  });
});

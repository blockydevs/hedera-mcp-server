import type { Client } from '@hiero-ledger/sdk';
import { AgentMode, type Configuration, type Context } from '@hashgraph/hedera-agent-kit';
import { WalletDeliveryStrategy } from '../signing/wallet-strategy.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  coreAccountPlugin,
  coreAccountQueryPlugin,
  coreConsensusPlugin,
  coreConsensusQueryPlugin,
  coreEVMPlugin,
  coreEVMQueryPlugin,
  coreMiscQueriesPlugin,
  coreTokenPlugin,
  coreTokenQueryPlugin,
  coreTransactionQueryPlugin,
} from '@hashgraph/hedera-agent-kit/plugins';
import { createSigningToolkit } from '../signing/toolkit.js';
import type { SigningRequestRegistry } from '../signing/requests.js';
import type { IntentRegistry } from '../signing/intent.js';
import type { WalletApprovalHook } from '../signing/approval-hook.js';
import type { WalletToolContext } from '../signing/tools.js';
import type { Options } from '../options.js';

export interface HederaServerWallet {
  registry: SigningRequestRegistry;
  intents: IntentRegistry;
  approvalHook: WalletApprovalHook;
  context: WalletToolContext;
}

/**
 * Builds the MCP server with all core plugins. `contextOverride` lets a per-session account
 * shadow the global context. When a wallet is bound, the approval hook is registered in the
 * tools' context BEFORE the toolkit is built (the tools read `context.hooks` at execution
 * time), so it can stamp the memo and record intent while the tools stay untouched — and the
 * write tools auto-deliver to the wallet.
 */
export function createHederaServer(
  options: Options,
  client: Client,
  contextOverride: Partial<Context> = {},
  wallet?: HederaServerWallet,
): McpServer {
  const context: Context = { ...options.context, ...contextOverride };
  if (wallet) {
    context.hooks = [...(context.hooks ?? []), wallet.approvalHook];
    // Wallet delivery IS the tools' terminal step in this mode, so the decision is made once
    // here rather than per tool. The strategy is per-session because it closes over this
    // session's wallet binding; the context (and the whole server) is built per `initialize`.
    // The CLI `--agent-mode` allowlist stays RETURN_BYTES-only — this mode is never operator-
    // selectable, it is set internally when a verified wallet session exists.
    context.mode = AgentMode.CUSTOM_RETURN_BYTES;
    context.transactionStrategy = new WalletDeliveryStrategy({
      walletContext: wallet.context,
      registry: wallet.registry,
      intents: wallet.intents,
    });
  }

  const configuration: Configuration = {
    tools: options.tools,
    context,
    plugins: [
      coreTokenPlugin,
      coreAccountPlugin,
      coreConsensusPlugin,
      coreAccountQueryPlugin,
      coreEVMPlugin,
      coreTokenQueryPlugin,
      coreConsensusQueryPlugin,
      coreEVMQueryPlugin,
      coreMiscQueriesPlugin,
      coreTransactionQueryPlugin,
    ],
  };

  return createSigningToolkit({
    client,
    configuration,
    wallet: wallet
      ? { registry: wallet.registry, intents: wallet.intents, walletContext: wallet.context }
      : undefined,
  });
}

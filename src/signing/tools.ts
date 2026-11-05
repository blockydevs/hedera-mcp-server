import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transaction } from '@hiero-ledger/sdk';
import type { SigningRequestRegistry } from './requests.js';
import {
  decodeTransaction,
  assertPayerIs,
  assertNoForeignDebits,
  assertMeaningfulTransfer,
  isWalletVerifiable,
  summarise,
} from './transaction.js';
import { fingerprintTransaction, type IntentRegistry } from './intent.js';
import { mcpJson, mcpError } from './mcp-result.js';
import { messageOf } from '../util.js';
import { numEnv } from '../config.js';
import type { WalletKind, WalletPresence } from '../wallet/wallet-presence.js';

/** Max simultaneously-pending wallet approvals per account. */
const MAX_CONCURRENT_APPROVALS = numEnv('MAX_CONCURRENT_APPROVALS', 3);

export class TooManyApprovalsError extends Error {
  constructor(limit: number) {
    super(
      `You already have ${limit} transactions awaiting approval in your wallet. ` +
        'Approve or reject those before submitting more.',
    );
    this.name = 'TooManyApprovalsError';
  }
}

/**
 * The wallet-approval tool surface: wallet_status, check_signing_status, and a shared
 * delivery routine ({@link buildApprovalResponse}) used both by the write tools' delivery
 * strategy (see wallet-strategy.ts) and by the standalone sign_with_wallet escape hatch.
 */

export interface WalletToolContext {
  accountId: string;
  topic: string;
  network: string;
  sessionExpiry?: number;
  resolveWallet?: () => ResolvedWallet;
}

export interface ResolvedWallet {
  presence: WalletPresence;
  approveUrl?: string;
}

// Unknown counts as an extension: at worst a redundant tab, never a wrong "check your phone".
function resolvedWallet(context: WalletToolContext): ResolvedWallet {
  return context.resolveWallet?.() ?? { presence: { kind: 'extension' } };
}

function whereToApprove(wallet: WalletPresence): string {
  if (wallet.kind === 'mobile') {
    return `in ${wallet.name ? `the ${wallet.name} app` : 'your wallet app'} on your phone`;
  }
  return wallet.name ? `in your ${wallet.name} browser extension` : 'in your wallet';
}

export interface ApprovalResponse {
  requestId: string;
  status: string;
  summary: string;
  walletVerifiable: boolean;
  walletKind: WalletKind;
  approveUrl?: string;
  hint: string;
}

/**
 * Validates a transaction against the wallet session and delivers it for approval, returning
 * the requestId envelope. Throws on a failed check (foreign payer/debit) — callers catch.
 *
 * Both entry points funnel through here: the write tools that auto-deliver, and the raw-bytes
 * sign_with_wallet. Since the bytes may have travelled through the model, the payer and debit
 * checks run here every time, regardless of how the transaction arrived.
 */
export function buildApprovalResponse(
  transaction: Transaction,
  context: WalletToolContext,
  registry: SigningRequestRegistry,
  intents?: IntentRegistry,
): ApprovalResponse {
  assertPayerIs(transaction, context.accountId);
  assertNoForeignDebits(transaction, context.accountId);
  assertMeaningfulTransfer(transaction, context.accountId);

  // Cap concurrent pending approvals per account (prompt-spam control): a
  // compromised or runaway agent must not be able to flood the wallet with prompts.
  if (registry.countAwaiting(context.accountId) >= MAX_CONCURRENT_APPROVALS) {
    throw new TooManyApprovalsError(MAX_CONCURRENT_APPROVALS);
  }

  // walletVerifiable is derived from the transaction directly — it is a security flag, so it
  // never depends on the intent registry being present or matching.
  const walletVerifiable = isWalletVerifiable(transaction);
  // The intent captured at build time gives a faithful summary; fall back to re-deriving one
  // from the transaction when the hook is off or the fingerprint doesn't match.
  const intent = intents?.get(fingerprintTransaction(transaction));
  const summary = intent?.summary ?? summarise(transaction);

  const request = registry.submit({
    accountId: context.accountId,
    topic: context.topic,
    transactionBase64: Buffer.from(transaction.toBytes()).toString('base64'),
    summary,
    walletVerifiable,
  });

  const { presence, approveUrl } = resolvedWallet(context);

  return {
    requestId: request.requestId,
    status: request.status,
    summary: request.summary,
    walletVerifiable,
    walletKind: presence.kind,
    approveUrl,
    hint: deliveryHint(walletVerifiable, presence, approveUrl),
  };
}

// Wallets don't open by themselves, so the agent must tell the user where to approve.
function deliveryHint(walletVerifiable: boolean, wallet: WalletPresence, approveUrl?: string): string {
  const tell =
    'Delivered to the user\'s wallet, which does not open by itself. ' +
    `Before anything else, tell the user: "A transaction is waiting for your approval ${whereToApprove(wallet)}."`;
  const act =
    wallet.kind === 'mobile'
      ? 'Do not open anything on this computer.'
      : approveUrl &&
        'If you can run shell commands, open this link now in the default browser yourself ' +
          '(macOS: open "<url>"; Windows: start "" "<url>"; Linux: xdg-open "<url>"). ' +
          `Always also give the user the link, which brings up the wallet's approval window: ${approveUrl} . ` +
          `If the wallet window does not appear, the user can select the Open button on that page or click the ${wallet.name ?? 'wallet'} icon in the browser toolbar.`;
  const warning =
    !walletVerifiable &&
    'WARNING: the wallet cannot fully decode this transaction type, so its display may not show what it does — relay this to the user.';
  const then =
    'Then call check_signing_status once with this requestId — it waits for their approval and returns the result. ' +
    'Do not ask the user whether they approved.';
  return [tell, act, warning, then].filter(Boolean).join(' ');
}

function walletSummary(context: WalletToolContext): { walletKind: WalletKind; walletName?: string } {
  const { presence } = resolvedWallet(context);
  return { walletKind: presence.kind, walletName: presence.name };
}

export function registerWalletTools(
  server: McpServer,
  registry: SigningRequestRegistry,
  context: WalletToolContext,
  intents?: IntentRegistry,
): void {
  server.registerTool(
    'wallet_status',
    {
      title: 'Wallet status',
      description:
        'Report the Hedera account this session signs with, the network, when the wallet session expires, and whether the wallet is a phone app or a browser extension. Use this to tell the user which account will pay.',
    },
    async () =>
      mcpJson({
        accountId: context.accountId,
        network: context.network,
        sessionExpiry: context.sessionExpiry
          ? new Date(context.sessionExpiry).toISOString()
          : undefined,
        ...walletSummary(context),
      }),
  );

  server.registerTool(
    'sign_with_wallet',
    {
      title: 'Send a transaction to the user for wallet approval',
      description:
        'Submit unsigned transaction bytes (from any Hedera write tool) to the user for approval in their wallet. ' +
        'Returns IMMEDIATELY with a requestId — it does not wait for the user. ' +
        'Do NOT wait for the user to confirm in chat: call check_signing_status to poll instead. ' +
        'Echo the returned summary to the user first, and if walletVerifiable is false, warn them their wallet cannot fully decode this transaction.',
      inputSchema: {
        bytes: z
          .string()
          .describe('Unsigned transaction bytes returned by a Hedera write tool (hex or base64)'),
      },
    },
    async ({ bytes }) => {
      try {
        const transaction = decodeTransaction(bytes);
        return mcpJson(buildApprovalResponse(transaction, context, registry, intents));
      } catch (error) {
        return mcpError(messageOf(error));
      }
    },
  );

  server.registerTool(
    'check_signing_status',
    {
      title: 'Check a wallet signing request',
      description:
        'Wait for a signing request to resolve. By default this BLOCKS until the user approves ' +
        'or rejects in their wallet (up to ~45s) and returns the final status — so call it ONCE ' +
        'after submitting; you do NOT need to poll repeatedly or ask the user whether they have ' +
        'approved. If it returns still awaiting_approval (the user was slow), simply call it again. ' +
        'Statuses: executed | rejected | failed | expired | needs_reauth | confirming | awaiting_approval. ' +
        'Pass waitMs:0 for a non-blocking check.',
      inputSchema: {
        requestId: z.string().describe('requestId returned by the write tool / sign_with_wallet'),
        waitMs: z
          .number()
          .optional()
          .describe('Max ms to wait for the user to act (default ~45000, max 55000; 0 = instant check)'),
      },
    },
    async ({ requestId, waitMs }) => {
      // Long-poll by default so the agent gets one blocking call instead of a poll loop; cap
      // under the MCP client's ~60s tool timeout.
      const wait = Math.min(Math.max(waitMs ?? 45_000, 0), 55_000);
      const request = wait > 0 ? await registry.waitForResolution(requestId, wait) : registry.get(requestId);
      if (!request) return mcpError(`Unknown requestId ${requestId}`);
      if (request.accountId !== context.accountId) {
        // Requests belong to the session that created them.
        return mcpError(`Unknown requestId ${requestId}`);
      }

      return mcpJson({
        requestId: request.requestId,
        status: request.status,
        summary: request.summary,
        transactionId: request.transactionId,
        hashscanUrl: request.transactionId
          ? `https://hashscan.io/${context.network}/transaction/${request.transactionId}`
          : undefined,
        error: request.error,
        nextStep: nextStepFor(request.status, resolvedWallet(context).presence),
      });
    },
  );
}

function nextStepFor(status: string, wallet: WalletPresence): string {
  switch (status) {
    case 'awaiting_approval':
      return `Still waiting on the user. Remind them: "It is still waiting for your approval ${whereToApprove(wallet)}." Then poll again.`;
    case 'confirming':
      return 'The user approved; the wallet broadcast it and we are confirming it on the mirror node. Poll again shortly.';
    case 'executed':
      return 'Done — signed, broadcast, and confirmed on-chain.';
    case 'failed':
      // Reached the network but did not succeed — never report this as done.
      return 'The transaction reached the network but failed on-chain. Inspect it on HashScan; do not assume the intended effect happened.';
    case 'rejected':
      return 'The user declined. Nothing moved. Do not retry unless asked.';
    case 'expired':
      // We hold only opaque bytes, so we cannot rebuild — the write tool must be re-run.
      return 'The request expired before approval. Re-run the original write tool to build a fresh transaction, then submit it again.';
    case 'needs_reauth':
      return 'The wallet session ended. The user must sign in again before you can request approvals.';
    default:
      return '';
  }
}

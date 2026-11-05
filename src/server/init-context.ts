import type { Request } from 'express';
import { LedgerId } from '@hiero-ledger/sdk';
import type { Context } from '@hashgraph/hedera-agent-kit';
import { walletAuthExtra } from '../auth/provider.js';
import { fetchAccountPublicKey } from '../wallet/mirror.js';
import type { SigningRequestRegistry } from '../signing/requests.js';
import type { IntentRegistry } from '../signing/intent.js';
import type { WalletApprovalHook } from '../signing/approval-hook.js';
import type { ResolvedWallet, WalletToolContext } from '../signing/tools.js';

export interface WalletBinding {
  registry: SigningRequestRegistry;
  intents: IntentRegistry;
  approvalHook: WalletApprovalHook;
  context: WalletToolContext;
}

export interface InitContext {
  contextOverride: Partial<Context>;
  walletBinding?: WalletBinding;
  /** The account the session is bound to (wallet mode only), for the session registry. */
  account?: string;
}

/** Wallet-signing services available to bind onto an initializing session. */
export interface InitDeps {
  ledgerId: LedgerId;
  registry: SigningRequestRegistry | null;
  intents: IntentRegistry | null;
  approvalHook: WalletApprovalHook | null;
  // Called per use, not at init: the WalletConnect session may not be readable yet.
  resolveWallet?: (topic: string) => ResolvedWallet;
}

const ACCOUNT_ID_RE = /^\d+\.\d+\.\d+$/;

/**
 * Derives the Agent-Kit context + wallet binding for an `initialize` request.
 *
 * In wallet mode the account comes from the verified token and the write tools are bound to
 * auto-deliver; in dev mode it comes from the (format-validated) `x-hedera-account-id` header.
 * A public key is fetched best-effort (timeout-bounded, cached — never blocks init). Returns a
 * `{ badRequest }` marker instead of throwing when the header is malformed, so the caller can
 * emit a clean 400.
 */
export async function buildInitContext(
  req: Request,
  deps: InitDeps,
): Promise<InitContext | { badRequest: string }> {
  const contextOverride: Partial<Context> = {};
  const authExtra = walletAuthExtra(req.auth);

  // Token wins in wallet mode; a header only applies in dev mode, and a duplicate
  // (array-valued) header is dropped since it flows into an outbound mirror-node call.
  const rawHeader = req.headers['x-hedera-account-id'];
  const headerAccountId: string | undefined =
    authExtra?.accountId || Array.isArray(rawHeader) ? undefined : rawHeader;
  if (headerAccountId && !ACCOUNT_ID_RE.test(headerAccountId)) {
    return { badRequest: 'Invalid x-hedera-account-id (expected shard.realm.num)' };
  }

  if (authExtra && deps.registry && deps.intents && deps.approvalHook) {
    contextOverride.accountId = authExtra.accountId;
    contextOverride.accountPublicKey = await fetchAccountPublicKey(deps.ledgerId, authExtra.accountId);
    const { resolveWallet } = deps;
    const topic = authExtra.topic;
    return {
      contextOverride,
      account: authExtra.accountId,
      walletBinding: {
        registry: deps.registry,
        intents: deps.intents,
        approvalHook: deps.approvalHook,
        context: {
          accountId: authExtra.accountId,
          topic,
          network: authExtra.network,
          sessionExpiry: authExtra.sessionExpiry,
          resolveWallet: resolveWallet ? () => resolveWallet(topic) : undefined,
        },
      },
    };
  }

  if (headerAccountId) {
    contextOverride.accountId = headerAccountId;
    contextOverride.accountPublicKey = await fetchAccountPublicKey(deps.ledgerId, headerAccountId);
  }
  return { contextOverride };
}

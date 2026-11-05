import { createRequire } from 'node:module';
import type { DAppConnector } from '@hashgraph/hedera-wallet-connect';
import type { SignClientTypes } from '@walletconnect/types';

/**
 * THE FRAGILE FILE. Injects a custom storage into WalletConnect so its sessions persist to
 * Postgres — the one thing `DAppConnector` won't let us do through its public API.
 *
 * `DAppConnector.init()` hard-codes `SignClient.init({logger, relayUrl, projectId, metadata})`
 * with no `storage` option. `SignClient`/`Core` DO accept `storage`, so we replicate what
 * `init()` does but pass our own — which means reaching into `DAppConnector` internals that
 * are TypeScript-`private` but real at runtime. If a `hedera-wallet-connect` bump renames or
 * removes any of them, {@link assertConnectorInternals} throws loudly at startup (and in
 * test/dapp-connector-init.test.ts) rather than failing silently in production.
 *
 * The long-term fix is an upstream `storage` passthrough on `DAppConnector`; once that lands,
 * delete this file and use `new DAppConnector(..., { storage })`.
 *
 * `@walletconnect/sign-client` is pinned to an exact version (no caret) matching the one
 * `hedera-wallet-connect` resolves internally. esbuild externalises it in the vendor bundle,
 * so both the vendored `DAppConnector` and our `require` below resolve the same hoisted copy —
 * one `SignClient` singleton, one session-object shape. (This guard covers `DAppConnector`
 * internals only; a breaking change in the sign-client API itself would not be caught here.)
 */

const RELAY_URL = 'wss://relay.walletconnect.com';

/** DAppConnector internals this bypass depends on — named so a version bump breaks loudly. */
const REQUIRED_INTERNALS = [
  'createSigners',
  'checkIframeConnect',
  'handleSessionEvent',
  'handleSessionUpdate',
  'handleSessionDelete',
  'handlePairingDelete',
] as const;

export function assertConnectorInternals(connector: DAppConnector): void {
  const target = connector as unknown as Record<string, unknown>;
  const missing = REQUIRED_INTERNALS.filter(name => typeof target[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `DAppConnector internals changed — the Postgres-storage init relies on ${missing.join(', ')}. ` +
        'hedera-wallet-connect likely bumped; update src/wallet/dapp-connector-init.ts.',
    );
  }
}

// SignClient is CJS; load it via require so the ESM/CJS interop can't hand us a wrapped
// namespace object instead of the constructor.
const require = createRequire(import.meta.url);

/**
 * Replicates `DAppConnector.init()` but with a custom `storage`. Mutates the passed connector
 * (sets `walletConnectClient`, `signers`, and the session/pairing event handlers) exactly as
 * `init()` would.
 */
export async function initDAppConnectorWithStorage(
  connector: DAppConnector,
  projectId: string,
  metadata: SignClientTypes.Metadata,
  storage: unknown,
): Promise<void> {
  assertConnectorInternals(connector);

  const SignClient = require('@walletconnect/sign-client').default ?? require('@walletconnect/sign-client');
  const c = connector as unknown as {
    walletConnectClient: any;
    signers: unknown[];
    createSigners: (session: unknown) => unknown[];
    checkIframeConnect: () => void;
    handleSessionEvent: (...args: unknown[]) => void;
    handleSessionUpdate: (...args: unknown[]) => void;
    handleSessionDelete: (...args: unknown[]) => void;
    handlePairingDelete: (...args: unknown[]) => void;
  };

  // Unlike DAppConnector.init() (which swallows this error and boots degraded), we fail
  // closed: a server that cannot reach the relay or has a bad projectId cannot sign anything,
  // so refuse to start with a clear message rather than come up broken.
  try {
    c.walletConnectClient = await SignClient.init({ relayUrl: RELAY_URL, projectId, metadata, storage });
  } catch (error) {
    throw new Error(
      'WalletConnect init failed — is the relay reachable and WALLETCONNECT_PROJECT_ID valid? ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  const existing = c.walletConnectClient.session.getAll();
  if (existing.length > 0) {
    c.signers = existing.flatMap((session: unknown) => c.createSigners(session));
  } else {
    c.checkIframeConnect();
  }

  c.walletConnectClient.on('session_event', c.handleSessionEvent.bind(c));
  c.walletConnectClient.on('session_update', c.handleSessionUpdate.bind(c));
  c.walletConnectClient.on('session_delete', c.handleSessionDelete.bind(c));
  c.walletConnectClient.core.events.on('session_delete', c.handleSessionDelete.bind(c));
  c.walletConnectClient.core.pairing.events.on('pairing_delete', c.handlePairingDelete.bind(c));
}

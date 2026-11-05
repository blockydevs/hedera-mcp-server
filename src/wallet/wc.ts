import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PublicKey } from '@hiero-ledger/sdk';
import type { DAppConnector as DAppConnectorType } from '@hashgraph/hedera-wallet-connect';

/**
 * Runtime access to the vendored WalletConnect bundle (see `wc-vendor-entry.ts`).
 *
 * Types come from the real package — tsc resolves those fine — while the runtime values
 * come from the bundle esbuild produced at build time.
 *
 * The load is lazy and cached: with wallet signing disabled the bundle is never touched, so
 * the RETURN_BYTES-only mode cannot be broken by a dependency it does not use.
 */

export interface WalletConnectRuntime {
  DAppConnector: typeof DAppConnectorType;
  HederaChainId: Record<string, string>;
  HederaJsonRpcMethod: Record<string, string>;
  HederaSessionEvent: Record<string, string>;
  verifyMessageSignature: (
    message: string,
    base64SignatureMap: string,
    publicKey: PublicKey,
  ) => boolean;
}

let cached: WalletConnectRuntime | undefined;

export function loadWalletConnect(): WalletConnectRuntime {
  if (cached) return cached;

  const here = dirname(fileURLToPath(import.meta.url));
  const bundlePath = join(here, '..', 'vendor', 'hedera-wallet-connect.cjs');

  try {
    cached = createRequire(import.meta.url)(bundlePath) as WalletConnectRuntime;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Node >= 25 exposes a `localStorage` global that is NON-FUNCTIONAL unless the process was
    // started with `--localstorage-file`. The bundle feature-detects `typeof localStorage`,
    // finds an object, and calls into it. Naming that here matters: the generic "run npm run
    // build" advice sends you looking for a missing artefact that is present and fine.
    const brokenWebStorage =
      /localStorage/.test(message) && typeof localStorage === 'object' && localStorage !== null;
    throw new Error(
      brokenWebStorage
        ? `The vendored WalletConnect bundle cannot run on ${process.version}: this Node exposes a ` +
          `non-functional \`localStorage\` global, which the bundle detects and then fails to use. ` +
          `Run on Node 24 (what the Docker image ships) — see the "engines" field. Original error: ${message}`
        : `Could not load the vendored WalletConnect bundle at ${bundlePath}. ` +
          `Run "npm run build" to generate it. Original error: ${message}`,
    );
  }
  return cached;
}

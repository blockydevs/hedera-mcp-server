/**
 * esbuild entry point for the vendored WalletConnect bundle. Not imported at runtime.
 *
 * `@hashgraph/hedera-wallet-connect` is published as unbundled ESM using extensionless and
 * directory imports (`export * from './lib'`), which Node's resolver cannot load — under
 * plain `node` it throws ERR_UNSUPPORTED_DIR_IMPORT, and TS-on-the-fly loaders resolve it
 * to a bare `default`. It is built for a bundler, so we bundle it: `npm run build` compiles this file
 * to `dist/vendor/hedera-wallet-connect.cjs`, which `wc.ts` then loads.
 *
 * CJS, not ESM: several transitive dependencies (tweetnacl among them) use dynamic
 * `require`, which an ESM bundle cannot express.
 */
export {
  DAppConnector,
  HederaChainId,
  HederaJsonRpcMethod,
  HederaSessionEvent,
  verifyMessageSignature,
} from '@hashgraph/hedera-wallet-connect';

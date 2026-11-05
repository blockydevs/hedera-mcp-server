import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

/**
 * Bundles `@hashgraph/hedera-wallet-connect` into a CJS file Node can actually load.
 *
 * That package is published as unbundled ESM with extensionless and directory imports
 * (`export * from './lib'`), which Node's resolver rejects outright. It targets a bundler,
 * so we run one over it.
 *
 * Only that package's own modules are bundled. Every other dependency stays external and is
 * required normally at runtime — they are ordinary, Node-resolvable packages, and pulling
 * them through the bundler breaks CJS/ESM interop (`@walletconnect/keyvaluestorage` exports
 * a default class that arrives undefined once rewritten). Keeping them external also takes
 * the artifact from ~9 MB to a few hundred KB.
 */

const TARGET = '@hashgraph/hedera-wallet-connect';

// esbuild drops upstream's plain `/* Copyright */` headers, so restate the attribution on the bundle.
const { version } = JSON.parse(
  await readFile(new URL(`../node_modules/${TARGET}/package.json`, import.meta.url), 'utf8'),
);
const BANNER = `/*! Bundles ${TARGET} ${version}. Copyright (C) 2023 Hedera Hashgraph, LLC. Apache-2.0 (see LICENSE and NOTICE). */`;

/** Externalises every bare specifier except the package we are here to bundle. */
const externaliseEverythingElse = {
  name: 'externalise-everything-else',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^[^./]|^\.[^./]/ }, args => {
      if (args.path === TARGET || args.path.startsWith(`${TARGET}/`)) return null;
      return { path: args.path, external: true };
    });
  },
};

await build({
  entryPoints: ['src/wallet/wc-vendor-entry.ts'],
  outfile: 'dist/vendor/hedera-wallet-connect.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  logLevel: 'error',
  banner: { js: BANNER },
  plugins: [externaliseEverythingElse],
});

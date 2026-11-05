import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { assertConnectorInternals } from '../src/wallet/dapp-connector-init.js';

const require = createRequire(import.meta.url);
const bundlePath = join(process.cwd(), 'dist/vendor/hedera-wallet-connect.cjs');

describe('assertConnectorInternals', () => {
  const goodStub = {
    createSigners: () => [],
    checkIframeConnect: () => {},
    handleSessionEvent: () => {},
    handleSessionUpdate: () => {},
    handleSessionDelete: () => {},
    handlePairingDelete: () => {},
  };

  it('passes when every relied-upon internal is present', () => {
    expect(() => assertConnectorInternals(goodStub as any)).not.toThrow();
  });

  it('throws, naming the missing internal, when one is gone', () => {
    const { createSigners: _drop, ...missing } = goodStub;
    expect(() => assertConnectorInternals(missing as any)).toThrow(/createSigners/);
  });

  // The real guard: load the ACTUAL vendored DAppConnector and confirm the private methods
  // the storage bypass reaches into still exist. This is what catches a lib bump.
  //
  // Skipped when the bundle has not been built (npm run build), and when the runtime cannot
  // load it at all. Node >= 25 exposes a non-functional `localStorage` global that the bundle
  // detects and then fails to use — the same reason the server itself cannot run wallet mode
  // there, which is why `engines` excludes it. Skipping is deliberate: a test that can NEVER
  // pass on a given runtime teaches everyone to ignore a red suite, and a failure here is a
  // real incompatibility, not "just an environment quirk". On a supported Node (24, what the Docker image ships) it runs for real.
  // Precisely: a `localStorage` that EXISTS but cannot be used. An absent one (Node <= 24) is
  // fine — the bundle takes its own fallback — and a working one is fine too, so neither skips.
  const unsupportedWebStorage =
    typeof localStorage === 'object' && localStorage !== null && typeof localStorage.getItem !== 'function';
  it.skipIf(!existsSync(bundlePath) || unsupportedWebStorage)(
    'the real DAppConnector still exposes the internals the bypass relies on',
    () => {
      const wc = require(bundlePath);
      expect(() => assertConnectorInternals(wc.DAppConnector.prototype)).not.toThrow();
    },
  );
});

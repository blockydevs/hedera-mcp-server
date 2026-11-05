import { LedgerId } from '@hiero-ledger/sdk';

/**
 * Wallet-signing configuration, read once at startup.
 *
 * The wallet path is opt-in: without WALLETCONNECT_PROJECT_ID and PUBLIC_URL the
 * server only returns unsigned transaction bytes (RETURN_BYTES, optional HMAC origin gate)
 * and needs no database, which keeps local development simple.
 */

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

/**
 * A positive-number env var, or the fallback. `Number('abc')` is `NaN`, and a `NaN` TTL
 * silently disables expiry (`NaN <= now` is always false), so a malformed value must fall
 * back rather than propagate.
 */
export function numEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A non-negative integer env var (allows 0), or the fallback. Unlike {@link numEnv} — whose
 * `> 0` guard is right for TTLs (0 = "disable expiry" is dangerous) — a count like the
 * trust-proxy hop count has a meaningful 0 (trust no proxy; don't honour X-Forwarded-For).
 */
export function intEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const projectId = env('WALLETCONNECT_PROJECT_ID');
const publicUrl = env('PUBLIC_URL');

// Fail loudly on a half-configured wallet. Setting exactly one of the pair almost always
// means an operator INTENDED to enable authenticated wallet signing — silently falling back
// to open dev mode (no OAuth, account from a header) would ship an unauthenticated server.
if (Boolean(projectId) !== Boolean(publicUrl)) {
  throw new Error(
    'Wallet signing is half-configured: set BOTH WALLETCONNECT_PROJECT_ID and PUBLIC_URL to ' +
      'enable it, or NEITHER to run in local dev mode. Refusing to start in an ambiguous state.',
  );
}

/** Wallet approval is only available when both the relay project and our own public URL are known. */
export const walletSigningEnabled = Boolean(projectId && publicUrl);

const databaseUrl = env('DATABASE_URL');
// The OAuth/session store lives in Postgres, so wallet signing needs a connection string.
if (walletSigningEnabled && !databaseUrl) {
  throw new Error(
    'Wallet signing requires DATABASE_URL (a Postgres connection string) for the session store.',
  );
}

/**
 * `wc_kv` holds live WalletConnect relay session keys — the one column class where a plaintext
 * database leak upgrades from a privacy problem to session-injection capability. A boot-time
 * warning is a log line that scrolls past; missing encryption must be a refusal, not a warning.
 * Plaintext storage requires the explicit WC_ALLOW_PLAINTEXT=true
 * opt-out, reserved for non-production environments.
 *
 * The scrypt salt is static, so the passphrase's own entropy is the entire defense against
 * precomputation — a short key must be rejected before it is ever derived.
 */
export const WC_KEY_MIN_LENGTH = 32;

export function assertWcEncryptionConfig(
  key: string | undefined,
  allowPlaintext: boolean,
  signingEnabled: boolean,
): void {
  if (!signingEnabled) return;
  if (!key && !allowPlaintext) {
    throw new Error(
      'WC_ENCRYPTION_KEY is not set — WalletConnect relay session keys would be stored in ' +
        'PLAINTEXT in the wc_kv table. Set it (e.g. `openssl rand -base64 32`, injected from ' +
        'your secrets manager), or set WC_ALLOW_PLAINTEXT=true to accept plaintext storage in ' +
        'a non-production environment. Refusing to start.',
    );
  }
  if (key && key.length < WC_KEY_MIN_LENGTH) {
    throw new Error(
      `WC_ENCRYPTION_KEY is too short (${key.length} chars, minimum ${WC_KEY_MIN_LENGTH}). ` +
        'The key-derivation salt is static, so the passphrase must carry the entropy itself — ' +
        'generate one with `openssl rand -base64 32`. Refusing to start.',
    );
  }
}

assertWcEncryptionConfig(
  env('WC_ENCRYPTION_KEY'),
  env('WC_ALLOW_PLAINTEXT') === 'true',
  walletSigningEnabled,
);

export const walletConfig = {
  projectId: projectId ?? '',
  /** Origin the browser ceremony runs on; also the `domain` bound into the sign-in nonce. */
  publicUrl: publicUrl ?? '',
  metadata: {
    name: env('DAPP_NAME') ?? 'Hedera MCP Server',
    description:
      env('DAPP_DESCRIPTION') ?? 'Hedera MCP server — transactions are approved in your wallet',
    url: publicUrl ?? 'https://example.com',
    icons: [env('DAPP_ICON_URL') ?? 'https://hedera.com/favicon.ico'],
  },
  /** Postgres connection string for the OAuth/session store. */
  databaseUrl: databaseUrl ?? '',
  /**
   * Auto-sync the schema from entities. Defaults OFF (fail-safe): the schema is owned by
   * reviewed migrations (`npm run migration:run`), so forgetting the flag in production does
   * NOT let TypeORM silently drop/rename columns. Set DB_SYNCHRONIZE=true only for throwaway
   * local dev where running a migration is inconvenient.
   */
  dbSynchronize: env('DB_SYNCHRONIZE') === 'true',
  /** Run pending migrations automatically at startup (convenient for single-instance deploys). */
  dbMigrationsRun: env('DB_MIGRATIONS_RUN') === 'true',
  /**
   * Passphrase for encrypting the WalletConnect session keys in `wc_kv` at rest.
   * Required in wallet mode (min 32 chars, validated above) unless WC_ALLOW_PLAINTEXT=true
   * explicitly accepts plaintext storage. Raw passphrase here; the 32-byte key is derived at use.
   */
  wcEncryptionKey: env('WC_ENCRYPTION_KEY'),
  /** Explicit opt-out of wc_kv encryption — non-production only. */
  wcAllowPlaintext: env('WC_ALLOW_PLAINTEXT') === 'true',

  /**
   * How long a signing request waits for the user before it is reported `expired`. Set to Hedera's ~180 s transaction-validity window: past that the frozen tx is
   * dead, so `expired` lines up with the transaction actually being unusable. A late-but-real
   * broadcast is still honoured — `onBroadcast` records it regardless of TTL and the mirror
   * node decides `executed` vs `expired` — so this bound is a give-up timer, not the safety
   * mechanism against double-spend.
   */
  requestTtlMs: numEnv('SIGN_REQUEST_TTL_MS', 180 * 1000),
  /** Sign-in nonce lifetime — single-use regardless. */
  nonceTtlMs: numEnv('SIGNIN_NONCE_TTL_MS', 5 * 60 * 1000),
  /**
   * Browser ceremony lifetime. Defaults to 5 min (not runtime-clamped): the ceremony holds the
   * pending `wc:` pairing URI, which embeds the pairing symmetric key, and that URI must live
   * no longer than the sign-in nonce (≤5 min) — so raising it past 5 min weakens that property.
   */
  ceremonyTtlMs: numEnv('CEREMONY_TTL_MS', 5 * 60 * 1000),

  accessTokenTtlMs: numEnv('ACCESS_TOKEN_TTL_MS', 60 * 60 * 1000),
  /** Never exceeds the WalletConnect session lifetime (7 days). */
  refreshTokenTtlMs: numEnv('REFRESH_TOKEN_TTL_MS', 7 * 24 * 60 * 60 * 1000),
};

export function caipChainId(ledgerId: LedgerId): string {
  return ledgerId === LedgerId.MAINNET ? 'hedera:mainnet' : 'hedera:testnet';
}

export function networkName(ledgerId: LedgerId): string {
  return ledgerId === LedgerId.MAINNET ? 'mainnet' : 'testnet';
}

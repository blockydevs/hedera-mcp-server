import { walletSigningEnabled } from '../config.js';
import { isOriginAuthVerificationEnabled } from '../auth/origin-auth.js';

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', ''];

/**
 * Refuse to start an unauthenticated server on a non-loopback address. Without wallet signing
 * or the HMAC origin gate, the server is an open RETURN_BYTES endpoint, fine on localhost
 * for dev, a security hole if exposed. Fails closed unless `ALLOW_INSECURE=true`.
 *
 * The auth checks are injectable so the guard is unit-testable without env surgery.
 */
export function assertSecureBind(
  host: string,
  opts: { authenticated?: boolean; allowInsecure?: boolean } = {},
): void {
  const authenticated = opts.authenticated ?? (walletSigningEnabled || isOriginAuthVerificationEnabled());
  const allowInsecure = opts.allowInsecure ?? process.env.ALLOW_INSECURE === 'true';
  if (LOOPBACK_HOSTS.includes(host) || authenticated || allowInsecure) return;
  throw new Error(
    `Refusing to bind ${host} with no authentication. Enable wallet signing ` +
      '(WALLETCONNECT_PROJECT_ID + PUBLIC_URL), set ORIGIN_AUTH_VERIFICATION_ENABLED=true, ' +
      'or set ALLOW_INSECURE=true to override (localhost binds are always allowed).',
  );
}

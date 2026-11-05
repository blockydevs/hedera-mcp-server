import { LedgerId } from '@hiero-ledger/sdk';
import { getMirrornodeService } from '@hashgraph/hedera-agent-kit';
import { withTimeout } from '../signing/requests.js';

/**
 * Best-effort fetch of an account's public key from the mirror node, for populating the
 * agent-kit context. It is used on the `initialize` request path, which must never block on a
 * slow external call: the lookup is timeout-bounded and cached, and a failure returns
 * `undefined` (the key is optional context) rather than throwing.
 *
 * Because the account id comes from the client, an unbounded lookup would let a caller stall
 * `initialize` by naming a slow-to-resolve account; the timeout prevents that, and the cache
 * bounds account enumeration (repeated lookups are cache hits).
 */

interface CacheEntry {
  key?: string;
  at: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 3000;

export async function fetchAccountPublicKey(
  ledgerId: LedgerId,
  accountId: string,
): Promise<string | undefined> {
  const hit = cache.get(accountId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.key;

  try {
    const account = await withTimeout(
      getMirrornodeService(undefined, ledgerId).getAccount(accountId),
      LOOKUP_TIMEOUT_MS,
    );
    cache.set(accountId, { key: account.accountPublicKey, at: Date.now() });
    return account.accountPublicKey;
  } catch {
    // Timeout, network error, or unknown account — the key is optional context, so proceed
    // without it rather than blocking or failing the request.
    return undefined;
  }
}

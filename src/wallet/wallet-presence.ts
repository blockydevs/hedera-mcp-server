/** Where the paired wallet lives, read from its WalletConnect peer metadata. */
export type WalletKind = 'extension' | 'mobile';

export interface WalletPresence {
  kind: WalletKind;
  name?: string;
  extensionId?: string;
}

// Wallets whose phone app was tested; untested wallets fall back to 'extension'.
const TESTED_WALLETS = new Set(['HashPack', 'Kabila Wallet']);

// The name ends up in text the agent relays to the user, so keep it short and single-line.
const MAX_NAME_CHARS = 40;

function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
    .trim()
    .slice(0, MAX_NAME_CHARS)
    .trim();
  return name || undefined;
}

const EXTENSION_URL = /^chrome-extension:\/\/([a-p]{32})(?:\/|$)/;

export function walletPresenceOf(
  metadata: { name?: unknown; url?: unknown } | undefined,
): WalletPresence {
  const name = cleanName(metadata?.name);
  const url = typeof metadata?.url === 'string' ? metadata.url : '';
  const extensionId = EXTENSION_URL.exec(url)?.[1];

  if (url.startsWith('chrome-extension://')) return { kind: 'extension', name, extensionId };
  if (name && TESTED_WALLETS.has(name)) return { kind: 'mobile', name };
  return { kind: 'extension', name };
}

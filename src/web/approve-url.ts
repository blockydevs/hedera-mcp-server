import type { WalletPresence } from '../wallet/wallet-presence.js';

// Extensions that only open their window from a real click, so the page must wait for one.
const CLICK_TO_OPEN = new Set(['cnoepnljjcacmnjnopbhjelpmfokpijm']); // Kabila Wallet

export function approveUrlFor(publicUrl: string, wallet: WalletPresence): string | undefined {
  if (!publicUrl || wallet.kind !== 'extension') return undefined;
  const url = new URL('/approve', publicUrl);
  if (wallet.extensionId) url.searchParams.set('ext', wallet.extensionId);
  if (wallet.extensionId && CLICK_TO_OPEN.has(wallet.extensionId)) url.searchParams.set('click', '1');
  return url.toString();
}

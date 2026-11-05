import type { Ceremony } from '../../auth/provider.js';

/**
 * Every user-visible string on the sign-in page, in one place.
 *
 * Style: sentence case everywhere except eyebrows and legal lines (so "AI agent", not "AI Agent"),
 * and the transaction warning is set as a labelled note rather than italics.
 *
 * NOTE: this module is imported by the page renderers, which tests load directly. It must
 * stay free of runtime imports from `../../config.js` -- that module throws at import time on a
 * half-configured wallet, and pulling it in here would make the page unrenderable without a full
 * environment. A type-only import, as above, erases at compile time and is fine.
 */

export const DOCS_URL = 'https://docs.hedera.com/solutions/ai/hosted-mcp-server';
export const LEARN_MORE_URL = 'https://hedera.com/mcp-servers/#hedera-network-mcp';

/** One run of text in a paragraph: a plain string, or a link. */
export type TextRun = string | { text: string; href: string };

/** The way out, shared by the intro and the expired page. */
export const HELP: readonly TextRun[] = [
  'Full setup steps are in the ',
  { text: 'MCP docs', href: DOCS_URL },
  ', or ',
  { text: 'learn more about Hedera Network MCP', href: LEARN_MORE_URL },
  '.',
];

/**
 * The intro paragraph, with the help links inline.
 *
 * They are repeated in the footer, but a link at the bottom of the page is not guidance -- a user
 * who does not know what a HIP-820 wallet is needs the way out inside the sentence that just used
 * the term, not below the fold. Rendered by `richText()` in shell.ts, which escapes every run, so
 * this stays plain data rather than markup.
 */
export const LEDE: readonly TextRun[] = [
  'Use this to connect your AI agent to your web3 wallet. Use a browser extension, or scan the ' +
    'QR code with your web3 wallet mobile app. ',
  ...HELP,
];

export const COPY = {
  title: 'Hedera Network MCP',
  eyebrow: 'Model context protocol (MCP)',
  network: 'Testnet',
  cautionLead: 'Before you approve',
  caution: 'Inspect and manually sign each transaction before your AI agent can execute it.',
  steps: ['Connect wallet', 'Approve sign-in', 'Return to your agent'],
  docsLink: 'MCP docs',
  learnMoreLink: 'Learn more',
  legal: '© 2026 hedera.com',
} as const;

/**
 * The line under the panel, one per ceremony status.
 *
 * Typed as a total record over `Ceremony['status']`, so adding a sixth status to the provider is
 * a compile error here rather than a screen that renders blank (a plain lookup would fall through
 * to '' for anything unlisted).
 */
export const STATUS_LABELS: Record<Ceremony['status'], string> = {
  pending: 'Preparing your sign-in request.',
  pairing: 'Waiting for you to approve the connection in your wallet.',
  awaiting_signature: 'Now approve the sign-in message in your wallet.',
  complete: 'Signed in. Returning you to your agent.',
  failed: '',
};

/** Panel copy for the states that are not driven by a ceremony status. */
export const PANEL_COPY = {
  preparingTitle: 'Preparing your sign-in',
  scanDivider: 'or scan with a mobile wallet',
  uriLabel: 'WalletConnect pairing URI',
  qrAlt: 'WalletConnect pairing QR code',
  copyUri: 'Copy pairing URI',
  copied: 'Copied',
  approveTitle: 'Approve the sign-in message',
  approveBody:
    'Your wallet is connected. Approve the sign-in message to prove you control this account. ' +
    'Nothing is signed on-chain and nothing is spent.',
  doneTitle: 'Connected',
  doneBody: 'Returning you to your agent.',
  failedTitle: 'Sign-in failed',
  failedBody: 'Return to your agent and start sign-in again.',
  failedFallback: 'The wallet did not complete sign-in.',
  expiredTitle: 'This sign-in request expired',
  expiredBody:
    'Sign-in requests are valid for five minutes. Return to your agent and start sign-in again.',
  noWalletTitle: 'No pairing available',
  noWalletBody: 'The server did not return a pairing request. Return to your agent and try again.',
} as const;

/** The approve page; also read by its client as JSON. */
export const APPROVE_COPY = {
  pageTitle: 'Approve in your wallet',
  title: 'Approve the transaction in your wallet',
  body:
    'Your AI agent sent a transaction to your wallet. Review it there and approve or reject it. ' +
    'If your wallet is on your phone, approve it there and close this tab.',
  openButton: 'Open wallet',
  searching: 'Looking for your wallet extension.',
  opened: 'Your wallet should now show the transaction. If it did not open, select the button above.',
  clickToOpen: 'Select the button above to bring up your wallet and review the transaction.',
  notFound:
    'No matching wallet extension answered in this browser. Open your wallet from the browser ' +
    'toolbar, or approve on your phone.',
  pick: 'Choose the wallet you signed in with.',
} as const;

import { HEDERA_LOCKUP_SVG } from '../brand/marks.js';
import { CONNECT_CSS } from './styles.js';
import { COPY, DOCS_URL, LEARN_MORE_URL, type TextRun } from './copy.js';

/**
 * Escapes text destined for HTML.
 *
 * The page it builds carries no untrusted data -- every string comes from `./copy.ts` -- so this
 * is not load-bearing today. It exists so that stays true by construction: it is applied at every
 * interpolation site, and there are only the handful below.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export { esc };

/**
 * Renders a paragraph's runs, escaping each one.
 *
 * Links are built here rather than written as markup in `copy.ts` so that copy stays data: there
 * is no path by which editing a string turns into editing HTML. Both the text and the href are
 * escaped, and the hrefs themselves are module constants, never user input.
 */
export function richText(runs: readonly TextRun[]): string {
  return runs
    .map(run =>
      typeof run === 'string' ? esc(run) : `<a href="${esc(run.href)}">${esc(run.text)}</a>`,
    )
    .join('');
}

/** JSON data block for a client script; `<` is escaped so a `</script` can't end it early. */
export function jsonIsland(id: string, payload: unknown, nonce: string): string {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<script type="application/json" id="${esc(id)}" nonce="${esc(nonce)}">${json}</script>`;
}

/** Chrome shared by every page: the sign-in, expired-request and approve pages. */
function masthead(): string {
  return `<div class="rule"></div>
<header class="masthead">
  <a class="brand" href="${esc(LEARN_MORE_URL)}">${HEDERA_LOCKUP_SVG}<span class="sr-only">Hedera</span></a>
  <span class="pill">${esc(COPY.network)}</span>
</header>`;
}

function footer(): string {
  return `<footer>
  <a href="${esc(DOCS_URL)}">${esc(COPY.docsLink)}</a>
  <a href="${esc(LEARN_MORE_URL)}">${esc(COPY.learnMoreLink)}</a>
  <span class="legal">${esc(COPY.legal)}</span>
</footer>`;
}

export interface ShellOptions {
  /** Document title. */
  title: string;
  /** Markup for the centred column. Must already be escaped. */
  main: string;
  /** CSP nonce for this response. The only value ever interpolated into a script position. */
  nonce: string;
  /** Optional trailing `<script>` blocks, already carrying the nonce. */
  scripts?: string;
}

/**
 * Renders a complete, self-contained document: fonts, styles, logo and script are all inlined,
 * so the page issues no subresource requests at all. That is what lets it run under a
 * `default-src 'none'` CSP, and it means no new route has to be signed by the HMAC edge gate.
 */
export function renderShell({ title, main, nonce, scripts = '' }: ShellOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${esc(title)}</title>
<style nonce="${esc(nonce)}">${CONNECT_CSS}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
</style>
</head>
<body>
${masthead()}
<div class="wrap"><main>${main}</main></div>
${footer()}
${scripts}</body>
</html>`;
}

import { CHECKMARK_SVG } from '../brand/marks.js';
import { CONNECT_CLIENT_JS } from './client.js';
import { COPY, HELP, LEDE, PANEL_COPY, STATUS_LABELS } from './copy.js';
import { esc, jsonIsland, renderShell, richText } from './shell.js';

/**
 * The sign-in page and its expired-request twin.
 *
 * Both are pure functions of a CSP nonce. Nothing about a specific ceremony is rendered server
 * side: the client reads the ceremony id from the page URL. That keeps every string here static,
 * and lets these be imported and rendered directly -- in a test, or anywhere else -- with no
 * provider, no database, no WalletConnect project id and no environment at all.
 */

/** Three steps, rendered inert; the client drives `data-state` and `aria-current`. */
function tracker(): string {
  const steps = COPY.steps
    .map(
      (label, index) => `<li class="step" data-state="${index === 0 ? 'current' : 'todo'}"${
        index === 0 ? ' aria-current="step"' : ''
      }>
      <span class="step-bar"></span>
      <span class="step-row">
        <span class="step-mark"><span class="mark-num">${index + 1}</span>${CHECKMARK_SVG.replace(
          '<svg ',
          '<svg class="mark-check" ',
        )}</span>
        <span class="step-label">${esc(label)}</span>
      </span>
    </li>`,
    )
    .join('\n    ');

  return `<ol class="tracker" id="tracker" data-halted="false">
    ${steps}
  </ol>`;
}

function main(): string {
  return `
  <p class="eyebrow">${esc(COPY.eyebrow)}</p>
  <h1>${esc(COPY.title)}</h1>
  <p class="lede">${richText(LEDE)}</p>
  <p class="caution"><b>${esc(COPY.cautionLead)}</b>${esc(COPY.caution)}</p>
  ${tracker()}
  <section class="panel" id="panel"></section>
  <p class="status" id="status" role="status" aria-live="polite"></p>
`;
}

/** The sign-in page. Renders the chrome; the client fills `#panel`. */
export function renderConnectPage(nonce: string): string {
  return renderShell({
    title: `Connect your wallet | ${COPY.title}`,
    main: main(),
    nonce,
    scripts: `${jsonIsland('page-copy', { status: STATUS_LABELS, panel: PANEL_COPY }, nonce)}
<script nonce="${esc(nonce)}">${CONNECT_CLIENT_JS}</script>
`,
  });
}

/**
 * Shown when `GET /connect` is hit with an unknown or expired ceremony id. It is the one screen a
 * user reaches by simply taking too long, so it gets the same treatment as the rest of the flow.
 */
export function renderExpiredPage(nonce: string): string {
  return renderShell({
    title: `Sign-in expired | ${COPY.title}`,
    main: `
  <p class="eyebrow">${esc(COPY.eyebrow)}</p>
  <h1>${esc(COPY.title)}</h1>
  <section class="panel">
    <h2>${esc(PANEL_COPY.expiredTitle)}</h2>
    <p>${esc(PANEL_COPY.expiredBody)}</p>
    <p>${richText(HELP)}</p>
  </section>
`,
    nonce,
  });
}

import { esc, jsonIsland, renderShell } from './shell.js';
import { APPROVE_COPY, COPY } from './copy.js';

/**
 * Opens the paired wallet extension's approval window over the hedera-extension postMessage
 * protocol. Opens unasked only when `?ext=<id>` answers; otherwise the user picks.
 */
export const APPROVE_CLIENT_JS = `
(function () {
  'use strict';

  var COPY = JSON.parse(document.getElementById('page-copy').textContent);
  var ORIGIN = window.location.origin;
  var EXT_QUERY = 'hedera-extension-query';
  var EXT_RESPONSE = 'hedera-extension-response';
  var EXT_OPEN = 'hedera-extension-open-';
  var EXT_ID = /^[a-p]{32}$/;
  var MAX_NAME_CHARS = 40;
  var CLOSE_AFTER_MS = 1500;

  var wanted = new URLSearchParams(window.location.search).get('ext') || '';
  if (!EXT_ID.test(wanted)) wanted = '';

  // Some wallets only open from a real click: try once, keep the tab, and leave the button.
  var clickToOpen = new URLSearchParams(window.location.search).get('click') === '1';

  var statusEl = document.getElementById('status');
  var openButton = document.getElementById('open-wallet');
  var picker = document.getElementById('wallets');
  var answered = [];
  var target = null;

  function setStatus(text) {
    statusEl.textContent = text;
  }

  /**
   * The icon is supplied by whatever extension answered discovery, so it is only used when it is
   * an inline image or plain https; otherwise the button simply goes without one.
   */
  function safeIconSrc(value) {
    if (typeof value !== 'string') return null;
    if (/^data:image\\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
    if (/^https:\\/\\//.test(value)) return value;
    return null;
  }

  function labelButton(button, ext) {
    button.textContent = 'Open ' + ext.name;
    if (!ext.icon) return;
    var icon = document.createElement('img');
    icon.src = ext.icon;
    icon.alt = '';
    button.prepend(icon);
  }

  function open(id) {
    window.postMessage({ type: EXT_OPEN + id }, ORIGIN);
    setStatus(COPY.opened);
  }

  function showPicker() {
    var buttons = answered.map(function (ext) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-ghost';
      labelButton(button, ext);
      button.addEventListener('click', function () {
        target = ext.id;
        open(ext.id);
      });
      return button;
    });
    picker.replaceChildren.apply(picker, buttons);
    setStatus(answered.length ? COPY.pick : COPY.notFound);
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== ORIGIN) return;
    var data = event.data;
    if (!data || data.type !== EXT_RESPONSE || !data.metadata || typeof data.metadata.id !== 'string') return;
    var id = data.metadata.id;
    if (answered.some(function (ext) { return ext.id === id; })) return;
    var name = typeof data.metadata.name === 'string' && data.metadata.name ? data.metadata.name : 'wallet';
    var ext = { id: id, name: name.slice(0, MAX_NAME_CHARS), icon: safeIconSrc(data.metadata.icon) };
    answered.push(ext);
    if (target) return;
    if (wanted && id === wanted && clickToOpen) {
      target = id;
      labelButton(openButton, ext);
      // Try anyway: it may work where the browser allows it. The tab stays open either way,
      // because the wallet never says whether it opened and the button is the fallback.
      open(id);
      setStatus(COPY.clickToOpen);
    } else if (wanted && id === wanted) {
      target = id;
      labelButton(openButton, ext);
      open(id);
      // The wallet's window is separate; this tab has done its job. Chrome allows a tab with a
      // single history entry to close itself; elsewhere this is a no-op and the tab stays.
      setTimeout(function () {
        window.close();
      }, CLOSE_AFTER_MS);
    } else if (!wanted) {
      showPicker();
    }
  });

  openButton.addEventListener('click', function () {
    if (target) open(target);
    else showPicker();
  });

  setStatus(COPY.searching);
  // Content scripts can inject after this script runs, so ask more than once.
  [0, 400, 1200].forEach(function (delay) {
    setTimeout(function () {
      if (!target) window.postMessage({ type: EXT_QUERY }, ORIGIN);
    }, delay);
  });
  setTimeout(function () {
    if (!target) showPicker();
  }, 2500);
})();
`;

export function renderApprovePage(nonce: string): string {
  return renderShell({
    title: `${APPROVE_COPY.pageTitle} | ${COPY.title}`,
    main: `
  <p class="eyebrow">${esc(COPY.eyebrow)}</p>
  <h1>${esc(COPY.title)}</h1>
  <section class="panel">
    <h2>${esc(APPROVE_COPY.title)}</h2>
    <p>${esc(APPROVE_COPY.body)}</p>
    <button type="button" class="btn btn-primary" id="open-wallet">${esc(APPROVE_COPY.openButton)}</button>
    <div class="wallets" id="wallets"></div>
  </section>
  <p class="status" id="status" role="status" aria-live="polite"></p>
`,
    nonce,
    scripts: `${jsonIsland('page-copy', APPROVE_COPY, nonce)}
<script nonce="${esc(nonce)}">${APPROVE_CLIENT_JS}</script>
`,
  });
}

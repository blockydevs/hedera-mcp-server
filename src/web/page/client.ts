/**
 * The sign-in page's client script, as a static string.
 *
 * Two rules hold this file together, and both are asserted by test/connect-page.test.ts:
 *
 * 1. NO `innerHTML`, ever. Every value rendered here is attacker-reachable: the pairing URI comes
 *    off the WalletConnect relay, the error text can be a wallet's own JSON-RPC rejection string,
 *    the account id is echoed from the wallet session, and extension names and icons come from
 *    whatever browser extension answered the discovery postMessage. Markup built from any of them
 *    would execute on the origin that also serves the OAuth authorization code. Everything is
 *    built with createElement and textContent.
 * 2. NO server-side interpolation into this string. Splicing a value in with JSON.stringify does
 *    not escape a literal `</script`, so it would be an injection point. The ceremony id is read
 *    from the page's own URL, and copy arrives through a JSON island, so this whole string is a
 *    constant and a stray interpolation is a compile error.
 */
export const CONNECT_CLIENT_JS = `
(function () {
  'use strict';

  var copyNode = document.getElementById('page-copy');
  var COPY = JSON.parse(copyNode.textContent);

  var panel = document.getElementById('panel');
  var statusEl = document.getElementById('status');
  var tracker = document.getElementById('tracker');
  var steps = Array.prototype.slice.call(tracker.querySelectorAll('.step'));

  // Read from our own URL rather than being templated in. The server has already refused to
  // render this page unless the id resolved to a live ceremony, and both endpoints re-validate.
  var ceremony = new URLSearchParams(window.location.search).get('ceremony') || '';
  var ORIGIN = window.location.origin;

  // Browser wallet extensions announce themselves over window.postMessage using the
  // hedera-wallet-connect extension protocol. This page speaks it directly, because our
  // DAppConnector runs server-side and cannot see the browser. Messages are origin-targeted
  // (never '*') and inbound ones are origin-checked.
  var EXT_QUERY = 'hedera-extension-query';
  var EXT_RESPONSE = 'hedera-extension-response';
  var EXT_CONNECT = 'hedera-extension-connect-';

  var pairingUri = null;
  var qrSrc = null;
  var accountId = null;
  var errorText = '';
  var extensions = [];
  var seenExtensions = {};
  var view = 'preparing';
  var stopped = false;

  // Polling budget. /connect/status shares a 120 req/min per-IP limit with /mcp, /authorize,
  // /register and /token, so a ~1s interval (~50 req/min per user) would let two users behind
  // one NAT rate-limit each other out of signing in. 2s, backing off to 4s after the first
  // minute, and a hard stop at the ceremony's own 5 minute TTL.
  var POLL_FAST_MS = 2000;
  var POLL_SLOW_MS = 4000;
  var BACKOFF_AFTER_MS = 60000;
  var GIVE_UP_AFTER_MS = 315000;
  var MAX_CONSECUTIVE_ERRORS = 5;
  var startedAt = Date.now();
  var consecutiveErrors = 0;

  var MAX_ERROR_CHARS = 300;
  var MAX_NAME_CHARS = 40;

  /* ---- small helpers ------------------------------------------------------------------- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clamp(value, max) {
    var text = typeof value === 'string' ? value : '';
    return text.length > max ? text.slice(0, max - 1) + '\\u2026' : text;
  }

  /** Hedera account ids are shard.realm.num. Anything else is not shown as one. */
  function isAccountId(value) {
    return typeof value === 'string' && /^[0-9]+\\.[0-9]+\\.[0-9]+$/.test(value);
  }

  /** Our own /connect/start builds this with the qrcode package; be strict about what we accept. */
  function isQr(value) {
    return typeof value === 'string' && /^data:image\\/png;base64,[A-Za-z0-9+/=]+$/.test(value);
  }

  /**
   * Extension icons are supplied by whatever extension answered discovery. An arbitrary URL here
   * turns the sign-in page into a beacon telling a third party that this user is signing in, so
   * only inline images and plain https are accepted, and anything else loses its icon rather than
   * blocking the wallet from being offered.
   */
  function safeIconSrc(value) {
    if (typeof value !== 'string') return null;
    if (/^data:image\\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
    if (/^https:\\/\\//.test(value)) return value;
    return null;
  }

  /* ---- tracker ------------------------------------------------------------------------- */

  var TRACKER_STEP = {
    preparing: 0,
    connect: 0,
    approving: 1,
    done: 2,
  };

  function setTracker(name) {
    var index = TRACKER_STEP[name];
    var halted = index === undefined;
    tracker.setAttribute('data-halted', halted ? 'true' : 'false');
    steps.forEach(function (step, i) {
      var state = 'todo';
      if (!halted && i < index) state = 'done';
      if (!halted && i === index) state = 'current';
      step.setAttribute('data-state', state);
      if (state === 'current') step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    });
  }

  /* ---- views --------------------------------------------------------------------------- */

  function walletButtons() {
    var box = el('div', 'wallets');
    extensions.forEach(function (meta) {
      var button = el('button', 'btn btn-ghost');
      button.type = 'button';
      if (meta.icon) {
        var icon = document.createElement('img');
        icon.src = meta.icon;
        icon.alt = '';
        button.appendChild(icon);
      }
      button.appendChild(document.createTextNode('Connect ' + meta.name));
      button.addEventListener('click', function () {
        if (!pairingUri) return;
        // Hand the wc: pairing URI to the extension; it pairs over the relay just like a QR scan.
        window.postMessage({ type: EXT_CONNECT + meta.id, pairingString: pairingUri }, ORIGIN);
        statusEl.textContent = COPY.status.pairing;
      });
      box.appendChild(button);
    });
    return box;
  }

  function copyButton() {
    var button = el('button', 'btn btn-ghost', COPY.panel.copyUri);
    button.type = 'button';
    button.addEventListener('click', function () {
      if (!pairingUri || !navigator.clipboard) return;
      navigator.clipboard.writeText(pairingUri).then(
        function () {
          button.textContent = COPY.panel.copied;
          setTimeout(function () {
            button.textContent = COPY.panel.copyUri;
          }, 1500);
        },
        function () {
          /* Clipboard denied; the URI is selectable on the page, so there is nothing to say. */
        },
      );
    });
    return button;
  }

  function messageView(title, body, extra) {
    var nodes = [el('h2', null, title), el('p', null, body)];
    if (extra) nodes.unshift(extra);
    return nodes;
  }

  var VIEWS = {
    preparing: function () {
      return [el('div', 'skeleton')];
    },

    connect: function () {
      var nodes = [];
      if (extensions.length) nodes.push(walletButtons());
      if (qrSrc) {
        if (extensions.length) nodes.push(el('div', 'divider', COPY.panel.scanDivider));
        var img = document.createElement('img');
        img.className = 'qr';
        img.alt = COPY.panel.qrAlt;
        img.src = qrSrc;
        nodes.push(img);
      }
      if (pairingUri) {
        var row = el('div', 'uri-row');
        var code = el('code', 'uri', pairingUri);
        code.setAttribute('aria-label', COPY.panel.uriLabel);
        row.appendChild(code);
        row.appendChild(copyButton());
        nodes.push(row);
      }
      return nodes;
    },

    approving: function () {
      var extra = isAccountId(accountId) ? el('span', 'account', accountId) : null;
      return messageView(COPY.panel.approveTitle, COPY.panel.approveBody, extra);
    },

    done: function () {
      var extra = isAccountId(accountId) ? el('span', 'account', accountId) : null;
      return messageView(COPY.panel.doneTitle, COPY.panel.doneBody, extra);
    },

    failed: function () {
      var nodes = [el('h2', null, COPY.panel.failedTitle)];
      nodes.push(el('p', 'error-text', errorText || COPY.panel.failedFallback));
      nodes.push(el('p', null, COPY.panel.failedBody));
      return nodes;
    },

    expired: function () {
      return messageView(COPY.panel.expiredTitle, COPY.panel.expiredBody);
    },

    noWallet: function () {
      return messageView(COPY.panel.noWalletTitle, COPY.panel.noWalletBody);
    },
  };

  var VIEW_STATUS = {
    preparing: COPY.status.pending,
    connect: COPY.status.pairing,
    approving: COPY.status.awaiting_signature,
    done: COPY.status.complete,
  };

  function setView(name) {
    view = name;
    panel.replaceChildren.apply(panel, VIEWS[name]());
    setTracker(name);
    statusEl.textContent = VIEW_STATUS[name] || '';
  }

  function fail(message) {
    errorText = clamp(message, MAX_ERROR_CHARS);
    stopped = true;
    setView('failed');
  }

  /* ---- extension discovery -------------------------------------------------------------- */

  function addExtension(meta) {
    if (!meta || typeof meta.id !== 'string' || seenExtensions[meta.id]) return;
    seenExtensions[meta.id] = true;
    extensions.push({
      id: meta.id,
      name: clamp(typeof meta.name === 'string' && meta.name ? meta.name : 'extension', MAX_NAME_CHARS),
      icon: safeIconSrc(meta.icon),
    });
    if (view === 'connect') setView('connect');
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== ORIGIN) return; // only trust messages from our own page context
    var data = event.data;
    if (data && data.type === EXT_RESPONSE && data.metadata) addExtension(data.metadata);
  });

  function detectExtensions() {
    window.postMessage({ type: EXT_QUERY }, ORIGIN);
  }

  /* ---- flow ------------------------------------------------------------------------------ */

  function applyStart(data) {
    if (data.status === 'failed') {
      fail(data.error);
      return;
    }
    pairingUri = typeof data.uri === 'string' ? data.uri : null;
    qrSrc = isQr(data.qr) ? data.qr : null;
    // A ceremony that has already moved on returns no uri; let the first poll place it rather
    // than showing an empty connect panel.
    if (!pairingUri && !qrSrc) {
      if (data.status === 'awaiting_signature' || data.status === 'complete') return;
      setView('noWallet');
      stopped = true;
      return;
    }
    setView('connect');
  }

  function applyStatus(data) {
    if (data.status === 'failed') {
      fail(data.error);
      return;
    }
    if (isAccountId(data.accountId)) accountId = data.accountId;

    if (data.status === 'complete' && typeof data.redirectTo === 'string') {
      setView('done');
      stopped = true;
      // Let the success state be seen before the browser leaves.
      setTimeout(function () {
        window.location.href = data.redirectTo;
      }, 900);
      return;
    }
    if (data.status === 'awaiting_signature') {
      if (view !== 'approving') setView('approving');
      return;
    }
    if (data.status === 'pairing' && view === 'preparing') setView('connect');
  }

  function nextDelay() {
    return Date.now() - startedAt > BACKOFF_AFTER_MS ? POLL_SLOW_MS : POLL_FAST_MS;
  }

  async function poll() {
    if (stopped) return;
    if (Date.now() - startedAt > GIVE_UP_AFTER_MS) {
      stopped = true;
      setView('expired');
      return;
    }

    var response;
    try {
      response = await fetch('/connect/status?ceremony=' + encodeURIComponent(ceremony));
    } catch (error) {
      // A transient network blip should not end a sign-in the user is halfway through.
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        stopped = true;
        setView('expired');
        return;
      }
      setTimeout(poll, nextDelay());
      return;
    }

    // Once a ceremony is pruned /connect/status 404s; without this check status would be
    // undefined, the label would fall through to '' and the page would poll forever showing nothing.
    if (response.status === 404) {
      stopped = true;
      setView('expired');
      return;
    }
    if (!response.ok) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        stopped = true;
        setView('expired');
        return;
      }
      setTimeout(poll, nextDelay());
      return;
    }

    consecutiveErrors = 0;
    var data = await response.json().catch(function () {
      return {};
    });
    applyStatus(data);
    if (!stopped) setTimeout(poll, nextDelay());
  }

  async function start() {
    var response = await fetch('/connect/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ceremony: ceremony }),
    });
    var data = await response.json().catch(function () {
      return {};
    });
    if (!response.ok) {
      fail(data.error);
      return;
    }

    applyStart(data);
    // Extensions may inject after load; query now and again shortly.
    detectExtensions();
    setTimeout(detectExtensions, 400);
    if (!stopped) poll();
  }

  setView('preparing');
  start().catch(function (error) {
    fail(String(error));
  });
})();
`;

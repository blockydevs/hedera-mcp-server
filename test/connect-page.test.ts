import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { renderConnectPage, renderExpiredPage } from '../src/web/page/connect-page.js';
import { CONNECT_CLIENT_JS } from '../src/web/page/client.js';
import { FONT_FACE_CSS } from '../src/web/brand/fonts.generated.js';
import { STATUS_LABELS, COPY, DOCS_URL, LEARN_MORE_URL } from '../src/web/page/copy.js';

/**
 * The sign-in page is HTML, CSS and browser JS living inside TypeScript template literals, which
 * means Prettier and ESLint see none of it. These assertions stand in for that missing coverage.
 * They deliberately do not test wording -- copy changes often and a snapshot of
 * it would only ever be noise.
 */

const NONCE = 'test-nonce-value';
const page = renderConnectPage(NONCE);

describe('connect page markup', () => {
  it('renders every hook the client script addresses', () => {
    // The client does getElementById on these and would throw on a rename. Nothing else catches
    // that: the page would serve 200 and render blank.
    for (const id of ['panel', 'status', 'tracker', 'page-copy']) {
      expect(page, `missing #${id}`).toContain(`id="${id}"`);
    }
    expect(page).toContain('class="step"');
    expect(page.match(/class="step"/g)).toHaveLength(COPY.steps.length);
    expect(page).toContain('class="mark-check"');
    expect(page).toContain('class="mark-num"');
  });

  it('carries the nonce on every script and style tag', () => {
    const tags = page.match(/<(?:script|style)\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag, `un-nonced tag: ${tag}`).toContain(`nonce="${NONCE}"`);
    }
  });

  it('renders both documented links', () => {
    expect(page).toContain(DOCS_URL);
    expect(page).toContain(LEARN_MORE_URL);
  });

  it('leaves no unresolved interpolation or undefined in the markup', () => {
    // Script bodies are excluded: the client legitimately compares against `undefined`. This is
    // about a copy constant going missing and rendering the word into the page.
    for (const html of [page, renderExpiredPage(NONCE)]) {
      const markup = html.replace(/<script[\s\S]*?<\/script>/g, '');
      expect(markup).not.toContain('${');
      expect(markup).not.toContain('undefined');
    }
  });

  it('closes the copy data block against an early </script>', () => {
    // A literal `</script` inside the JSON island would end it early and dump the rest as markup.
    const island = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(page);
    expect(island).not.toBeNull();
    expect(island![1]).not.toContain('</script');
    expect(() => JSON.parse(island![1].replace(/\\u003c/g, '<'))).not.toThrow();
  });

  it('is under the page byte budget', () => {
    // Everything is inlined and served uncompressed with no-store, so this is the real per-load
    // cost. If this fails, something new was inlined: check the font weights in
    // scripts/build-fonts.mjs first, they are ~25 KB of base64 each.
    expect(page.length).toBeLessThan(300_000);
  });
});

describe('connect page client script', () => {
  it('builds no markup from strings', () => {
    // Every value the client renders is attacker-reachable (relay URI, wallet error text, account
    // id, extension name and icon). textContent is the only rendering path allowed.
    for (const banned of ['innerHTML', 'outerHTML', 'document.write', 'insertAdjacentHTML']) {
      expect(CONNECT_CLIENT_JS, `client uses ${banned}`).not.toContain(banned);
    }
  });

  it('has no server-side interpolation site', () => {
    // The whole point of reading the ceremony id from the URL. A `${` here means someone spliced
    // server data into the script, which is an injection point.
    expect(CONNECT_CLIENT_JS).not.toContain('${');
    expect(CONNECT_CLIENT_JS).not.toContain('</script');
  });

  it('covers every ceremony status with a label', () => {
    // STATUS_LABELS is typed as a total Record over Ceremony['status'], so a new status is a
    // compile error. This checks the values are actually present at runtime too.
    expect(Object.keys(STATUS_LABELS).sort()).toEqual(
      ['awaiting_signature', 'complete', 'failed', 'pairing', 'pending'].sort(),
    );
  });
});

describe('inlined brand assets', () => {
  it('inlines three real woff2 payloads', () => {
    const payloads = [...FONT_FACE_CSS.matchAll(/base64,([A-Za-z0-9+/=]+)\)/g)].map(m => m[1]);
    expect(payloads).toHaveLength(3);
    for (const payload of payloads) {
      // Catches a truncated or mis-generated blob, which would otherwise ship a page whose fonts
      // silently fall back to a system font.
      expect(Buffer.from(payload, 'base64').subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
  });
});

describe('page package isolation', () => {
  it('imports nothing from config at runtime', () => {
    // src/config.ts throws at import time on a half-configured wallet. If the page package ever
    // imports it, these tests stop working and the failure looks like an unrelated env problem
    // rather than a stray import. Keeping the view layer env-free is also what lets the page be
    // rendered anywhere it needs to be.
    for (const file of ['client.ts', 'connect-page.ts', 'copy.ts', 'shell.ts', 'styles.ts']) {
      const source = readFileSync(new URL(`../src/web/page/${file}`, import.meta.url), 'utf8');
      const runtimeImports = source.match(/^import (?!type )[\s\S]*?from '(.*)';$/gm) ?? [];
      expect(runtimeImports.join('\n'), `${file} imports config`).not.toContain('config');
    }
  });
});

import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import QRCode from 'qrcode';
import type { WalletOAuthProvider } from '../auth/provider.js';
import { walletConfig } from '../config.js';
import { renderConnectPage, renderExpiredPage } from './page/connect-page.js';
import { setPageHeaders } from './page-headers.js';

/**
 * Rejects a cross-site POST. `/connect/start` triggers a real WalletConnect pairing, so a
 * page on another origin must not be able to fire it with a guessed ceremony id. We
 * require the request to declare an Origin (or Referer) matching our own public URL; a
 * same-origin fetch from the connect page always does, a cross-site form POST does not.
 */
export function originAllowed(
  headers: { origin?: string; referer?: string },
  expectedUrl: string,
): boolean {
  let expected: string;
  try {
    expected = new URL(expectedUrl).origin;
  } catch {
    return false;
  }
  if (headers.origin) return headers.origin === expected;
  if (headers.referer) {
    try {
      return new URL(headers.referer).origin === expected;
    } catch {
      return false;
    }
  }
  // Neither header present — a browser fetch/XHR always sends Origin for POST, so absence is
  // treated as not same-origin.
  return false;
}

function isSameOrigin(req: Request): boolean {
  return originAllowed(
    { origin: req.get('origin'), referer: req.get('referer') },
    walletConfig.publicUrl,
  );
}

/**
 * The browser half of the sign-in ceremony.
 *
 * This is the OAuth "login form": the user pairs a wallet, approves a nonce, and the page
 * forwards them back to the MCP client's redirect URI with an authorization code. The
 * `wc:` URI is rendered as a QR here and never leaves this page — it embeds the pairing
 * symmetric key, so it is treated as a secret with the ceremony's own short TTL.
 *
 * The page itself lives in `./page/`, which holds no ceremony state and imports nothing from
 * `../config.js`, so it can be rendered without a provider, a database or a wallet.
 */

/**
 * Reads a query parameter that must be a single string.
 *
 * Express parses `?ceremony[x]=y` into an OBJECT and `?ceremony=a&ceremony=b` into an array,
 * so `String(req.query.ceremony)` can yield `'[object Object]'` or `'a,b'` — a value that was
 * never sent. Returning '' for anything that is not a plain string keeps a caller from
 * fabricating a lookup key out of a structured parameter.
 */
function stringQuery(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Per-response CSP nonce, kept off `res.locals` so it stays typed. */
const nonces = new WeakMap<Response, string>();

function nonceFor(res: Response): string {
  return nonces.get(res) ?? '';
}

export function createConnectRouter(provider: WalletOAuthProvider): Router {
  const router = Router();

  router.use('/connect', (_req: Request, res: Response, next: NextFunction) => {
    const nonce = randomBytes(16).toString('base64');
    nonces.set(res, nonce);

    // On top of the shared headers (./page-headers.ts):
    //   img-src data:  — the QR is a data: PNG built by the qrcode package.
    //   img-src https: — browser wallet extensions supply their own icon URLs. The client
    //                    validates each one before assigning it (see page/client.ts).
    //   connect-src    — /connect/start and /connect/status, same origin. The extension
    //                    protocol is postMessage only and needs no origin here.
    // Nothing under /connect is cacheable: the page is scoped to a single short-lived ceremony
    // and the status endpoint is polled for a value that changes.
    setPageHeaders(res, nonce, { img: "'self' data: https:", connect: "'self'" });
    next();
  });

  router.get('/connect', (req: Request, res: Response) => {
    const ceremonyId = stringQuery(req.query.ceremony);
    if (!provider.getCeremony(ceremonyId)) {
      res
        .status(404)
        .type('html')
        .send(renderExpiredPage(nonceFor(res)));
      return;
    }
    res.type('html').send(renderConnectPage(nonceFor(res)));
  });

  // Starts the pairing and returns the QR. POST so it is not triggered by a prefetch.
  router.post('/connect/start', async (req: Request, res: Response) => {
    if (!isSameOrigin(req)) {
      res.status(403).json({ error: 'Cross-origin request refused' });
      return;
    }
    const ceremonyId = String(req.body?.ceremony ?? '');
    try {
      const ceremony = await provider.runCeremony(ceremonyId);
      const qr = ceremony.uri ? await QRCode.toDataURL(ceremony.uri) : undefined;
      res.json({ status: ceremony.status, uri: ceremony.uri, qr });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get('/connect/status', (req: Request, res: Response) => {
    const ceremony = provider.getCeremony(stringQuery(req.query.ceremony));
    if (!ceremony) {
      res.status(404).json({ error: 'Unknown sign-in request' });
      return;
    }
    res.json({
      status: ceremony.status,
      accountId: ceremony.accountId,
      error: ceremony.error,
      // Only ever the client's registered redirect URI, carrying the code.
      redirectTo: ceremony.status === 'complete' ? ceremony.redirectTo : undefined,
    });
  });

  return router;
}

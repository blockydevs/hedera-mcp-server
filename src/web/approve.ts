import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { renderApprovePage } from './page/approve-page.js';
import { setPageHeaders } from './page-headers.js';

/** `GET /approve`: a static page that brings the wallet extension's approval window up. */
export function createApproveRouter(): Router {
  const router = Router();

  router.get('/approve', (_req: Request, res: Response) => {
    const nonce = randomBytes(16).toString('base64');
    // img-src: wallet extensions announce their own icon; the page validates it before use.
    setPageHeaders(res, nonce, { img: "'self' data: https:" });
    res.type('html').send(renderApprovePage(nonce));
  });

  return router;
}

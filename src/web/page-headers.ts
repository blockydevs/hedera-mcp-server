import type { Response } from 'express';

export interface PageSources {
  img?: string;
  connect?: string;
}

/** Never framed (clickjacking), nonce-only CSP, never cached. */
export function setPageHeaders(res: Response, nonce: string, sources: PageSources = {}): void {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      ...(sources.img ? [`img-src ${sources.img}`] : []),
      'font-src data:',
      ...(sources.connect ? [`connect-src ${sources.connect}`] : []),
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('Cache-Control', 'no-store');
}

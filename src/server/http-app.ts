import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import {
  hostHeaderValidation,
  localhostHostValidation,
} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';

export type RequestWithRawBody = Request & { rawBody?: Buffer };

function captureRawBody(req: Request, _res: Response, buf: Buffer): void {
  (req as RequestWithRawBody).rawBody = buf;
}

/**
 * Refuses compressed request bodies before anything reads them. body-parser 2.x decompresses
 * `Content-Encoding: br`, which is the unauthenticated path to CVE-2026-111497 (Node2Shell), and
 * the parsers run above the HMAC gate. No MCP or OAuth client compresses its requests, so every
 * encoding but identity is refused, including any a parser mounted later might accept.
 */
function rejectEncodedBodies(req: Request, res: Response, next: NextFunction): void {
  const encoding = (req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  if (encoding !== 'identity') {
    res.status(415).json({ error: 'Content-Encoding not supported' });
    return;
  }
  next();
}

/**
 * Mirrors createMcpExpressApp from the MCP SDK, but captures req.rawBody for the HMAC gate.
 * Every parser needs the hook: a body no parser claims reaches the gate unhashable. JSON covers
 * /mcp and /connect, form encoding covers /token and /revoke. `inflate: false` makes the parsers
 * themselves refuse compressed bodies too, in case rejectEncodedBodies is ever moved.
 */
export function createHttpApp(host: string, allowedHosts?: string[]): Express {
  const app = express();
  app.use(rejectEncodedBodies);
  app.use(express.json({ inflate: false, verify: captureRawBody }));
  app.use(express.urlencoded({ extended: false, inflate: false, verify: captureRawBody }));

  if (allowedHosts) {
    app.use(hostHeaderValidation(allowedHosts));
  } else {
    const localhostHosts = ['127.0.0.1', 'localhost', '::1'];
    if (localhostHosts.includes(host)) {
      app.use(localhostHostValidation());
    } else if (host === '0.0.0.0' || host === '::') {
      console.warn(
        `Warning: Server is binding to ${host} without DNS rebinding protection. ` +
          'Consider using the allowedHosts option to restrict allowed hosts, ' +
          'or use authentication to protect your server.',
      );
    }
  }

  return app;
}

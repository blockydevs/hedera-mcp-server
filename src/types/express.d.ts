import type { Logger } from '../logger.js';

// Per-request correlation logger, attached by the request-logging middleware in configureMcpHttp.
declare module 'express-serve-static-core' {
  interface Request {
    log?: Logger;
  }
}

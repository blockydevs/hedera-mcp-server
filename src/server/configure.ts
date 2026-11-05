import { randomUUID } from 'node:crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import type { DataSource } from 'typeorm';
import type { Client } from '@hiero-ledger/sdk';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import rateLimit from 'express-rate-limit';
import { walletConfig, walletSigningEnabled, numEnv, intEnv } from '../config.js';
import { messageOf } from '../util.js';
import type { Options } from '../options.js';
import { createHederaServer } from './hedera-server.js';
import {
  isOriginAuthVerificationEnabled,
  loadOriginAuthSecret,
  verifyOriginAuth,
} from '../auth/origin-auth.js';
import type { RequestWithRawBody } from './http-app.js';
import { logger } from '../logger.js';
import { createConnectRouter } from '../web/connect.js';
import { createApproveRouter } from '../web/approve.js';
import { approveUrlFor } from '../web/approve-url.js';
import { walletAuthExtra, type WalletOAuthProvider } from '../auth/provider.js';
import { SessionRegistry } from './session-registry.js';
import { buildInitContext } from './init-context.js';
import { rpcError, rpcId } from './rpc.js';
import type { SessionStore } from '../store/session-store.js';
import type { WalletApprover } from '../wallet/approver.js';
import type { SigningRequestRegistry } from '../signing/requests.js';
import type { IntentRegistry } from '../signing/intent.js';
import type { WalletApprovalHook } from '../signing/approval-hook.js';

export interface McpHttpDeps {
  options: Options;
  client: Client;
  provider: WalletOAuthProvider | null;
  approver: WalletApprover | null;
  registry: SigningRequestRegistry | null;
  intents: IntentRegistry | null;
  approvalHook: WalletApprovalHook | null;
  store: SessionStore | null;
  dataSource: DataSource | null;
}

const SESSION_IDLE_TTL_MS = 60 * 60 * 1000;

export interface McpHttpHandle {
  /** Closes every open MCP transport so the HTTP server can drain and exit gracefully. */
  close(): Promise<void>;
}

/**
 * Wires the MCP HTTP surface onto the (Nest-owned) Express app: the OAuth router, the connect
 * page, the `/mcp` transport lifecycle, session-account binding, and the periodic prunes. The
 * domain services are injected (built by the NestJS providers) rather than created here — this
 * is purely the request-handling layer the MCP SDK mandates in Express terms.
 */
export function configureMcpHttp(app: Express, deps: McpHttpDeps): McpHttpHandle {
  const { options, client, provider, approver, registry, intents, approvalHook, store, dataSource } = deps;

  // Liveness/readiness probes, mounted FIRST so they are never rate-limited, auth-gated, or
  // logged as request spam. /healthz answers whenever the event loop is running; /readyz also
  // round-trips the database (dev mode has no DB, so readiness collapses to liveness).
  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });
  app.get('/readyz', async (_req: Request, res: Response) => {
    // A missing WC_ENCRYPTION_KEY refuses to boot unless WC_ALLOW_PLAINTEXT overrides it; when
    // it does, expose that state here so monitoring can alert on it — a boot log line is not a
    // signal anything watches.
    const wcKv = walletSigningEnabled && !walletConfig.wcEncryptionKey ? { wcKv: 'plaintext' } : {};
    try {
      // Dev mode has no database, so readiness collapses to liveness.
      if (dataSource) await dataSource.query('SELECT 1');
      res.status(200).json({ status: 'ready', ...wcKv });
    } catch (error) {
      res.status(503).json({ status: 'unavailable', error: messageOf(error) });
    }
  });

  // Owns per-session transports, account bindings, and idle eviction.
  const sessions = new SessionRegistry(SESSION_IDLE_TTL_MS);
  // Caps concurrent sessions so an unauthenticated flood cannot exhaust memory (the OOM DoS).
  const MAX_SESSIONS = numEnv('MAX_SESSIONS', 500);

  // Rate-limit the request path ahead of session creation and the open OAuth/connect routes,
  // so an anonymous client cannot loop initialize/register/authorize to exhaust resources.
  // Trust the proxy hop count so the limiter keys on the real client IP behind a TLS proxy.
  const perIpLimit = rateLimit({
    windowMs: 60_000,
    limit: numEnv('RATE_LIMIT_PER_MINUTE', 120),
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.set('trust proxy', intEnv('TRUST_PROXY_HOPS', 1));
  app.use(['/mcp', '/authorize', '/register', '/token', '/connect', '/approve'], perIpLimit);

  // Attach a per-request correlation logger to EVERY request (registered before the OAuth and
  // connect routers so those routes are logged too). Session IDs are bearer-equivalent, so only
  // a short prefix is logged.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    const reqId = randomUUID();
    const sid = req.headers['mcp-session-id'];
    const sidPrefix = typeof sid === 'string' ? `${sid.slice(0, 8)}…` : undefined;
    if (typeof sid === 'string') sessions.touch(sid, start);

    req.log = logger.child({ reqId, ...(sidPrefix ? { sessionId: sidPrefix } : {}) });
    req.log.info('request', { method: req.method, path: req.path });
    res.on('finish', () => {
      req.log!.info('response', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - start,
      });
    });
    next();
  });

  // Optional HMAC origin gate: a trusted edge proxy signs method, path, timestamp, nonce and a
  // hash of the raw body. The secret is read once at startup, not per request, and the digest
  // compare is constant-time.
  //
  // Mounted here, above the OAuth and connect routers, so it covers the WHOLE request surface:
  // an Express router that handles a path ends the chain, so a gate below them would leave
  // /authorize, /token, /register, /.well-known/* and /connect reachable straight from the
  // internet. Only /healthz and /readyz sit above it, deliberately: orchestrator probes hit the
  // container directly rather than through the edge, so they cannot carry a signature.
  if (isOriginAuthVerificationEnabled()) {
    const secretPromise = loadOriginAuthSecret();
    app.use((req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const secret = await secretPromise;
          // Undefined for bodyless requests, which the edge signs with an empty hash too.
          const rawBody = (req as RequestWithRawBody).rawBody;
          if (!verifyOriginAuth(req, rawBody, secret)) {
            res.status(401).send('Unauthorized');
            return;
          }
        } catch (error) {
          logger.error('unable to verify origin HMAC', { error: messageOf(error) });
          res.status(500).send('Server configuration error');
          return;
        }
        next();
      })();
    });
  }

  if (provider && approver && registry && intents && store) {
    // A wallet disconnect must invalidate the grants riding on it, not just fail later.
    approver.onSessionGone(topic => {
      registry.markSessionGone(topic);
      void store
        .purgeByTopic(topic)
        .then(refs => {
          if (refs.length) logger.warn('purged pairings for closed session', { topic, count: refs.length });
        })
        .catch(error => logger.error('failed to purge session', { topic, error: messageOf(error) }));
    });

    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: new URL(walletConfig.publicUrl),
        scopesSupported: ['hedera:sign'],
        resourceName: 'Hedera MCP Server',
      }),
    );
    app.use(createConnectRouter(provider));
    app.use(createApproveRouter());

    setInterval(() => {
      registry.prune();
      intents.prune();
      provider.prune();
      void store.prune().catch(error => logger.error('store prune failed', { error: messageOf(error) }));
    }, 60_000).unref();

    logger.info('wallet signing enabled', { signInUrl: walletConfig.publicUrl });
  } else {
    logger.warn('wallet signing disabled (set WALLETCONNECT_PROJECT_ID and PUBLIC_URL to enable)');
  }

  // Evict idle sessions whose client vanished without DELETE /mcp.
  setInterval(() => sessions.evictIdle(), 60_000).unref();

  // A session may only be used by the account that opened it (POST/GET/DELETE).
  const rejectForeignSession = (req: Request, res: Response, sessionId: string): boolean => {
    if (sessions.isForeign(sessionId, walletAuthExtra(req.auth)?.accountId)) {
      rpcError(res, 403, -32003, 'Session belongs to a different account', rpcId(req.body));
      return true;
    }
    return false;
  };

  // When wallet signing is on, /mcp requires a bearer token whose subject is a verified account.
  if (provider) {
    app.use(
      '/mcp',
      requireBearerAuth({
        verifier: provider,
        resourceMetadataUrl: new URL('/.well-known/oauth-protected-resource', walletConfig.publicUrl).toString(),
      }),
    );
  }

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    // The request/response lines are already emitted (correlated) by the middleware above; log
    // only the JSON-RPC method here, on the same reqId.
    req.log?.debug('mcp method', { method: req.body?.method ?? 'N/A' });

    try {
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        if (rejectForeignSession(req, res, sessionId!)) return;
        await existing.handleRequest(req, res, req.body);
        return;
      }
      if (sessionId) {
        rpcError(res, 404, -32001, 'Session not found', null);
        return;
      }
      if (!isInitializeRequest(req.body)) {
        rpcError(res, 400, -32000, 'Bad Request: Session ID required', null);
        return;
      }

      // New session. Cap the count so a flood can't grow the map without bound.
      if (sessions.size >= MAX_SESSIONS) {
        rpcError(res, 429, -32000, 'Too many active sessions; try again later', rpcId(req.body));
        return;
      }

      const init = await buildInitContext(req, {
        ledgerId: options.ledgerId!,
        registry,
        intents,
        approvalHook,
        resolveWallet: approver
          ? topic => {
              const presence = approver.walletPresence(topic);
              return { presence, approveUrl: approveUrlFor(walletConfig.publicUrl, presence) };
            }
          : undefined,
      });
      if ('badRequest' in init) {
        rpcError(res, 400, -32000, init.badRequest, rpcId(req.body));
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          logger.info('session initialized', { sessionId: sid.slice(0, 8) + '…' });
          sessions.add(sid, transport, init.account);
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && sessions.has(sid)) {
          logger.info('session closed', { sessionId: sid.slice(0, 8) + '…' });
          sessions.remove(sid);
        }
      };

      const server = createHederaServer(options, client, init.contextOverride, init.walletBinding);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      (req.log ?? logger).error('error handling MCP request', { error: messageOf(error) });
      if (!res.headersSent) rpcError(res, 500, -32603, 'Internal server error', null);
    }
  });

  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!sessionId) return void res.status(400).send('Missing session ID');
    if (!transport) return void res.status(404).send('Session not found');
    if (rejectForeignSession(req, res, sessionId)) return;
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!sessionId) return void res.status(400).send('Missing session ID');
    if (!transport) return void res.status(404).send('Session not found');
    if (rejectForeignSession(req, res, sessionId)) return;
    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      (req.log ?? logger).error('error handling session termination', { error: messageOf(error) });
      if (!res.headersSent) res.status(500).send('Error processing session termination');
    }
  });

  return { close: () => sessions.closeAll() };
}


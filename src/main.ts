import 'dotenv/config';
import 'reflect-metadata';
import type { DataSource } from 'typeorm';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { createHttpApp } from './server/http-app.js';
import { AppModule } from './app.module.js';
import { parseArgs, handleError, type Options } from './options.js';
import { logger } from './logger.js';
import { configureMcpHttp } from './server/configure.js';
import { assertSecureBind } from './server/bind-guard.js';
import { releaseInstanceLockGuard } from './database/instance-lock.js';
import { walletSigningEnabled, walletConfig } from './config.js';
import {
  APP_OPTIONS,
  HEDERA_CLIENT,
  DATA_SOURCE,
  SESSION_STORE,
  WALLET_APPROVER,
  OAUTH_PROVIDER,
  SIGNING_REGISTRY,
  INTENT_REGISTRY,
  APPROVAL_HOOK,
} from './tokens.js';

/**
 * NestJS entry point. The MCP SDK is Express-native, so the app runs on an SDK-shaped Express
 * instance (host validation, JSON body parsing, raw-body capture) wrapped by NestJS's
 * ExpressAdapter. NestJS owns the dependency graph and lifecycle (the DataSource connects and
 * the WalletApprover restores its sessions inside the module's async providers); the MCP/OAuth
 * request surface is wired onto the same Express instance by configureMcpHttp.
 */
async function bootstrap(): Promise<void> {
  // A stray unhandled rejection must not terminate a multi-user server.
  process.on('unhandledRejection', reason => {
    logger.error('unhandled promise rejection', { error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason) });
  });

  // Parsed once here for the pre-boot Express app config (host validation must be set before
  // Nest wraps the app); the DI graph re-derives its own copy via APP_OPTIONS.
  const bootOptions = parseArgs(process.argv.slice(2));
  assertSecureBind(bootOptions.host);

  // Mirrors the SDK's createMcpExpressApp (DNS-rebinding host validation + express.json()) but
  // additionally retains the raw request bytes on req.rawBody, which the HMAC origin gate hashes.
  // Nest sits on top of it, so we disable Nest's own body parser to avoid parsing twice.
  const expressApp = createHttpApp(bootOptions.host, bootOptions.allowedHosts);
  // Don't advertise the framework, and set baseline response headers.
  expressApp.disable('x-powered-by');
  expressApp.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  const app = await NestFactory.create(AppModule, new ExpressAdapter(expressApp), {
    bodyParser: false,
    logger: ['error', 'warn'],
  });

  const options = app.get<Options>(APP_OPTIONS);
  const dataSource = app.get<DataSource | null>(DATA_SOURCE);
  if (dataSource) logger.info('connected to Postgres session store');

  // Missing WC_ENCRYPTION_KEY in wallet mode fails closed at config load; this branch is only
  // reachable through the explicit WC_ALLOW_PLAINTEXT=true opt-out. Still warn on every boot —
  // the opt-out must never quietly become permanent in a production deploy.
  if (walletSigningEnabled && !walletConfig.wcEncryptionKey) {
    logger.warn(
      'WC_ALLOW_PLAINTEXT is set — WalletConnect session keys are stored UNENCRYPTED in the ' +
        'wc_kv table. Set WC_ENCRYPTION_KEY (from your secrets manager) before production.',
    );
  }

  const http = configureMcpHttp(expressApp, {
    options,
    client: app.get(HEDERA_CLIENT),
    provider: app.get(OAUTH_PROVIDER),
    approver: app.get(WALLET_APPROVER),
    registry: app.get(SIGNING_REGISTRY),
    intents: app.get(INTENT_REGISTRY),
    approvalHook: app.get(APPROVAL_HOOK),
    store: app.get(SESSION_STORE),
    dataSource,
  });

  // Graceful shutdown: close the MCP transports (so the HTTP server can drain), then the Nest
  // app, then the Postgres pool. Without closing transports first, app.close() hangs on the
  // never-ending SSE streams until the orchestrator SIGKILLs the process.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    await http.close();
    await app.close().catch(error => logger.error('app.close failed', { error: String(error) }));
    // Past this point losing the instance lock is intended, not a failure — stop the guard
    // before the pool tears its connections down so a teardown error can't force exit(1).
    releaseInstanceLockGuard();
    await dataSource?.destroy().catch(error => logger.error('DataSource.destroy failed', { error: String(error) }));
    logger.info('shutdown complete');
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen(options.port, options.host);
  logger.info('server running', { url: `http://${options.host}:${options.port}/mcp` });
}

bootstrap().catch(error => {
  handleError(error);
  process.exit(1);
});

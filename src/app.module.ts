import { Module } from '@nestjs/common';
import { Client, LedgerId } from '@hiero-ledger/sdk';
import { getMirrornodeService } from '@hashgraph/hedera-agent-kit';
import type { DataSource } from 'typeorm';
import { walletSigningEnabled, walletConfig } from './config.js';
import { logger } from './logger.js';
import { createDataSource } from './database/data-source.js';
import { acquireInstanceLock } from './database/instance-lock.js';
import { SessionStore } from './store/session-store.js';
import { WalletApprover } from './wallet/approver.js';
import { WalletOAuthProvider } from './auth/provider.js';
import { SigningRequestRegistry, toMirrorTransactionId, type ConfirmFn } from './signing/requests.js';
import { IntentRegistry } from './signing/intent.js';
import { WalletApprovalHook } from './signing/approval-hook.js';
import { parseArgs, type Options } from './options.js';
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
 * The application's dependency graph. Every domain service is a provider here, wired through
 * NestJS DI. The wallet-signing services resolve to `null` when the server runs in dev mode
 * (no `WALLETCONNECT_PROJECT_ID`/`PUBLIC_URL`), which the HTTP wiring checks — the server's
 * two run modes, expressed as conditional providers.
 *
 * Async factories carry the startup lifecycle: the DataSource
 * connects, and the WalletApprover initialises its WalletConnect client (restoring sessions
 * from Postgres), before the app starts serving.
 */
@Module({
  providers: [
    { provide: APP_OPTIONS, useFactory: (): Options => parseArgs(process.argv.slice(2)) },

    {
      provide: HEDERA_CLIENT,
      useFactory: (options: Options): Client =>
        options.ledgerId === LedgerId.MAINNET ? Client.forMainnet() : Client.forTestnet(),
      inject: [APP_OPTIONS],
    },

    {
      provide: DATA_SOURCE,
      useFactory: async (): Promise<DataSource | null> => {
        if (!walletSigningEnabled) return null;
        if (walletConfig.dbSynchronize) {
          // Auto-sync rewrites the schema from the entities on boot — convenient in dev, but a
          // data-loss risk in production (a column rename/drop applies with no review). Set
          // DB_SYNCHRONIZE=false and run migrations before deploying.
          logger.warn('DB_SYNCHRONIZE is on — TypeORM will auto-sync the schema; disable it (use migrations) in production');
        }
        const dataSource = await createDataSource({
          url: walletConfig.databaseUrl,
          synchronize: walletConfig.dbSynchronize,
          migrationsRun: walletConfig.dbMigrationsRun,
        });
        // Single-instance is a hard requirement (docs/DATABASE.md); a second replica against
        // the same database refuses to boot rather than silently racing the first.
        await acquireInstanceLock(dataSource);
        return dataSource;
      },
    },

    {
      provide: SESSION_STORE,
      useFactory: (dataSource: DataSource | null): SessionStore | null =>
        dataSource ? new SessionStore(dataSource) : null,
      inject: [DATA_SOURCE],
    },

    {
      provide: WALLET_APPROVER,
      useFactory: async (
        options: Options,
        dataSource: DataSource | null,
      ): Promise<WalletApprover | null> => {
        if (!dataSource) return null;
        const approver = new WalletApprover(options.ledgerId!, dataSource);
        await approver.init();
        return approver;
      },
      inject: [APP_OPTIONS, DATA_SOURCE],
    },

    {
      provide: OAUTH_PROVIDER,
      useFactory: (
        store: SessionStore | null,
        approver: WalletApprover | null,
        options: Options,
      ): WalletOAuthProvider | null =>
        store && approver ? new WalletOAuthProvider(store, approver, options.ledgerId!) : null,
      inject: [SESSION_STORE, WALLET_APPROVER, APP_OPTIONS],
    },

    {
      provide: INTENT_REGISTRY,
      useFactory: (): IntentRegistry | null =>
        walletSigningEnabled ? new IntentRegistry(walletConfig.requestTtlMs) : null,
    },

    {
      provide: APPROVAL_HOOK,
      useFactory: (intents: IntentRegistry | null): WalletApprovalHook | null =>
        intents ? new WalletApprovalHook(intents) : null,
      inject: [INTENT_REGISTRY],
    },

    {
      provide: SIGNING_REGISTRY,
      useFactory: (options: Options, approver: WalletApprover | null): SigningRequestRegistry | null => {
        if (!approver) return null;
        // Confirm a broadcast reached consensus rather than trusting the wallet's word.
        const mirror = getMirrornodeService(undefined, options.ledgerId!);
        const confirm: ConfirmFn = async transactionId => {
          const data: any = await mirror.getTransactionRecord(toMirrorTransactionId(transactionId));
          const record = data?.transactions?.[0];
          if (!record) return 'not_found';
          return record.result === 'SUCCESS' ? 'success' : 'failed';
        };
        return new SigningRequestRegistry(approver, walletConfig.requestTtlMs, confirm);
      },
      inject: [APP_OPTIONS, WALLET_APPROVER],
    },
  ],
  exports: [
    APP_OPTIONS,
    HEDERA_CLIENT,
    DATA_SOURCE,
    SESSION_STORE,
    WALLET_APPROVER,
    OAUTH_PROVIDER,
    SIGNING_REGISTRY,
    INTENT_REGISTRY,
    APPROVAL_HOOK,
  ],
})
export class AppModule {}

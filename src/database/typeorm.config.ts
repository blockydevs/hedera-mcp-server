import 'reflect-metadata';
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { postgresOptions } from './data-source.js';

/**
 * Standalone DataSource for the TypeORM CLI (migration:generate / :run / :revert). Reuses the
 * runtime `postgresOptions` (so the CLI and the app can never drift), with synchronize off —
 * production owns its schema through reviewed migrations, not `synchronize`.
 *
 * Runs against the compiled JS (build first): `npm run migration:run`.
 */
export default new DataSource(
  postgresOptions({ url: process.env.DATABASE_URL ?? '', synchronize: false }),
);

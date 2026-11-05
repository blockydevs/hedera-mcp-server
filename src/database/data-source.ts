import 'reflect-metadata';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { GrantEntity } from './entities/grant.entity.js';
import { PairingEntity } from './entities/pairing.entity.js';
import { AuthCodeEntity } from './entities/auth-code.entity.js';
import { OAuthClientEntity } from './entities/oauth-client.entity.js';
import { WcKvEntity } from './entities/wc-kv.entity.js';

/**
 * The persistence layer for OAuth/session state. Backs the {@link SessionStore} with Postgres
 * in production and sqlite in tests — the entities are written to be portable across both
 * (bigint-as-number timestamps, `simple-json`/`simple-array` columns), so the store's logic
 * runs identically under each.
 */

export const ENTITIES = [GrantEntity, PairingEntity, AuthCodeEntity, OAuthClientEntity, WcKvEntity];

export interface DatabaseConfig {
  url: string;
  /**
   * Auto-create/patch the schema from the entities. Off in production (the schema is owned by
   * migrations); required for the in-memory sqlite used by tests.
   */
  synchronize: boolean;
  /** Run pending migrations at startup (an alternative to a separate `migration:run` step). */
  migrationsRun?: boolean;
}

// Resolve the migrations glob relative to THIS module, not process.cwd() — otherwise a
// process started from another directory (systemd WorkingDirectory, a container WORKDIR)
// globs zero files and silently applies no migrations.
const MIGRATIONS_GLOB = join(dirname(fileURLToPath(import.meta.url)), 'migrations', '*.js');

export function postgresOptions(config: DatabaseConfig): DataSourceOptions {
  return {
    type: 'postgres',
    url: config.url,
    entities: ENTITIES,
    migrations: [MIGRATIONS_GLOB],
    synchronize: config.synchronize,
    migrationsRun: config.migrationsRun ?? false,
    logging: ['error'],
  };
}

/** Creates and initialises the Postgres DataSource. */
export async function createDataSource(config: DatabaseConfig): Promise<DataSource> {
  const dataSource = new DataSource(postgresOptions(config));
  await dataSource.initialize();
  return dataSource;
}

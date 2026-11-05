import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { ENTITIES } from '../src/database/data-source.js';

/**
 * A throwaway in-memory sqlite DataSource for store tests. The entities are DB-portable, so
 * the store logic under test runs the same here as against Postgres in production — while
 * keeping the suite fast and offline. Each test gets a fresh schema.
 */
export async function createTestDataSource(): Promise<DataSource> {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: ENTITIES,
    synchronize: true,
    logging: false,
  });
  await dataSource.initialize();
  return dataSource;
}

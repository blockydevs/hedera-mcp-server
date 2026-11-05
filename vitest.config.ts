import { defineConfig } from 'vitest/config';

// Quiet the structured logger during tests (logger.test.ts sets its own level per-case).
process.env.LOG_LEVEL ??= 'silent';

export default defineConfig({
  test: {
    // TypeORM decorators require reflect-metadata to be loaded before any entity module.
    setupFiles: ['reflect-metadata'],
  },
});

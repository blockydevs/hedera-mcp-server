import type { ValueTransformer } from 'typeorm';

/**
 * Stores an epoch-millisecond timestamp as `bigint` and reads it back as a number.
 *
 * Postgres returns `bigint` columns as strings (to avoid precision loss beyond 2^53); ms
 * timestamps are ~1.7e12, well within a JS number, so we coerce on read. On sqlite `bigint`
 * maps to INTEGER and already reads as a number — the coercion is a harmless no-op there.
 * Keeping timestamps as numbers preserves the existing `expiresAt <= Date.now()` semantics
 * used throughout the store.
 */
export const msTimestamp: ValueTransformer = {
  to: (value?: number | null) => value ?? null,
  from: (value?: string | number | null) => (value == null ? value : Number(value)),
};

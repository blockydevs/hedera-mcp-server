# Database Specification — Hedera MCP Server

The persistence layer for the **wallet-signing (non-custodial) mode**. It stores the OAuth /
session state and WalletConnect's own key-value store, so that issued tokens and live wallet
sessions survive a server restart coherently. Dev mode (RETURN_BYTES with no wallet) uses no
database at all.

This document specifies the schema. For the surrounding system see [`SPEC.md`](SPEC.md) (the data
model is summarised in its §7); for the ORM/lifecycle code see `src/database/` and
`src/store/session-store.ts`.

> **Single-instance is a hard architectural requirement.** Exactly one server process runs
> against a given database. Several guarantees depend on it — migrations run without an advisory
> lock (§2), and sign-in nonces, browser-ceremony state, and pending signing requests are
> in-memory only (§6). This is **enforced at boot**, not just documented: the server takes a
> Postgres session-level advisory lock keyed on (name, database OID)
> (`src/database/instance-lock.ts`), and a second process against the same database refuses to
> start after a short retry window. Do not autoscale this service horizontally. Two operational
> constraints follow — see [§10](#10-deployment-constraints).

---

## 1. Engine & portability

| Aspect | Value |
|---|---|
| ORM | TypeORM |
| Production engine | **PostgreSQL** (developed against `postgres:17-alpine`) |
| Test engine | **in-memory SQLite** (`synchronize: true`) |
| Schema ownership | **Migrations** (`src/database/migrations/`), not auto-sync |
| `DB_SYNCHRONIZE` | Default **off** in production — a forgotten flag must never silently drop/rename columns |

The entities are written to be **portable across Postgres and SQLite** so the store logic runs
identically under both. Two deliberate constraints make that work, and are load-bearing:

- **Timestamps are `bigint` epoch-milliseconds**, transformed to/from a JS `number` on the way in
  and out (`src/database/columns.ts`, `msTimestamp`). Postgres returns `bigint` as a string to
  avoid precision loss past 2^53; ms timestamps (~1.7×10¹²) are well inside a safe `number`, so
  the transformer coerces on read. On SQLite `bigint`→`INTEGER` already reads as a number.
- **Structured columns are stored as `text`**, not `jsonb`/native arrays: `simple-json`
  (JSON-stringified) and `simple-array` (comma-joined). This is portable but means **the database
  cannot index into or query the contents** of those columns — they are opaque blobs read back
  whole by the application.

---

## 2. Schema ownership & migrations

The schema is created and versioned by TypeORM migrations. The initial migration
`1785146320131-InitialSchema.ts` creates all five tables and their indexes.

```bash
npm run migration:run                        # apply pending migrations (builds first)
npm run migration:generate --name=AddThing   # after an entity change, generate the diff
npm run migration:revert                      # roll back the last migration
```

- **Deploy** as a discrete step (a k8s Job / initContainer running `npm run migration:run`), or
  set `DB_MIGRATIONS_RUN=true` to apply pending migrations at startup on a single instance.
- The migrations glob is resolved **relative to the compiled module**, not `process.cwd()`, so a
  process started from another working directory still finds its migrations
  (`src/database/data-source.ts`).
- There is **no migration advisory lock** — with a single instance (the enforced topology, see
  above) this is fine. The boot-time instance lock is acquired *after* `initialize()` (which is
  what runs `DB_MIGRATIONS_RUN` migrations), so two instances booting in the same moment could
  still race migrations before one loses the lock and exits — prefer running migrations as a
  discrete deploy step when that window matters.

---

## 3. Entity–relationship overview

No foreign-key constraints are declared. All relationships are **logical**, enforced in
application code (e.g. `SessionStore.purgeByTopic` cascades a wallet disconnect). This keeps the
schema portable and the writes cheap; the tradeoff is that referential integrity is the
application's responsibility.

```mermaid
erDiagram
    oauth_clients ||--o{ grants     : "clientId"
    oauth_clients ||--o{ auth_codes : "clientId"
    pairings      ||--o{ grants     : "pairingRef"
    pairings      ||--o{ auth_codes : "pairingRef"

    oauth_clients {
        varchar  clientId PK
        text     data
        bigint   issuedAt
    }
    pairings {
        varchar  pairingRef PK
        varchar  topic
        varchar  accountId
        varchar  network
        bigint   createdAt
        bigint   expiresAt
    }
    grants {
        varchar  tokenHash PK
        varchar  clientId
        varchar  pairingRef
        varchar  accountId
        text     scopes
        boolean  isRefresh
        bigint   expiresAt
    }
    auth_codes {
        varchar  codeHash PK
        varchar  clientId
        varchar  redirectUri
        varchar  codeChallenge
        varchar  pairingRef
        varchar  accountId
        bigint   expiresAt
    }
```

- **`pairings`** is the anchor: a WalletConnect pairing bound 1:1 to a proven Hedera account.
- **`grants`** and **`auth_codes`** both reference a `pairingRef` (which wallet session backs the
  token/code) and a `clientId` (which OAuth client it was issued to).
- **`wc_kv`** (not shown above) is WalletConnect's own opaque key-value store. It relates to
  `pairings` only *logically* — the routing `topic` in a pairing row corresponds to a session
  whose relay keys live, JSON-encoded, inside `wc_kv` values. There is no column-level join.

---

## 4. Tables

Postgres column types are shown as created by the migration. All columns are `NOT NULL` unless
noted. `varchar` is unbounded (`character varying`) unless a length is given.

### 4.1 `grants` — issued OAuth grants (access & refresh tokens)

An issued access or refresh token. **The token itself is never stored**; the primary key is its
SHA-256 hash, so a leaked database cannot be replayed as a bearer token.

| Column | Type | Notes |
|---|---|---|
| `tokenHash` | `varchar(64)` **PK** | SHA-256 hex of the bearer token |
| `clientId` | `varchar` | → `oauth_clients.clientId` (logical) |
| `pairingRef` | `varchar` | → `pairings.pairingRef` (logical); **indexed** |
| `accountId` | `varchar` | Hedera account the token authorises (`0.0.x`) |
| `scopes` | `text` (`simple-array`) | Comma-joined OAuth scopes |
| `isRefresh` | `boolean` | `DEFAULT false`; `true` on refresh-token rows |
| `expiresAt` | `bigint` (ms) | **indexed**; access ≈ 1 h, refresh ≈ 7 d, never beyond the pairing |

**Indexes:** PK(`tokenHash`), `IDX(pairingRef)`, `IDX(expiresAt)`.

### 4.2 `pairings` — WalletConnect pairing ↔ proven account

A WalletConnect pairing bound 1:1 to a token subject: the routing topic plus the account proven
at sign-in.

| Column | Type | Notes |
|---|---|---|
| `pairingRef` | `varchar` **PK** | Opaque pairing reference |
| `topic` | `varchar` | WalletConnect session topic (delivery routing key); **indexed** |
| `accountId` | `varchar` | Proven Hedera account |
| `network` | `varchar` | `testnet` / `mainnet` |
| `createdAt` | `bigint` (ms) | |
| `expiresAt` | `bigint` (ms) | **indexed**; the WalletConnect session lifetime |

**Indexes:** PK(`pairingRef`), `IDX(topic)`, `IDX(expiresAt)`.

### 4.3 `auth_codes` — single-use OAuth authorization codes

A single-use OAuth authorization code (authorization-code + PKCE flow). Keyed by its SHA-256 hash;
consumed on redemption.

| Column | Type | Notes |
|---|---|---|
| `codeHash` | `varchar(64)` **PK** | SHA-256 hex of the authorization code |
| `clientId` | `varchar` | → `oauth_clients.clientId` (logical) |
| `redirectUri` | `varchar` | Bound at issue; must match at redemption |
| `codeChallenge` | `varchar` | PKCE challenge; verifier checked at redemption |
| `pairingRef` | `varchar` | → `pairings.pairingRef` (logical) |
| `accountId` | `varchar` | Proven account carried into the grant |
| `expiresAt` | `bigint` (ms) | **indexed**; short-lived (set by the OAuth provider) |

**Indexes:** PK(`codeHash`), `IDX(expiresAt)`.

**Single-use guarantee.** `consumeAuthCode` deletes the row and treats **only** the caller whose
`DELETE` reports `affected === 1` as the redeemer; an in-process claim map additionally closes
the read-then-delete TOCTOU window before the query is issued. The delete count is itself
**atomic across processes**: Postgres serializes concurrent `DELETE`s of the same row (the loser
blocks, re-evaluates, and reports `affected = 0` under the default READ COMMITTED isolation), so
double redemption cannot occur even multi-instance. `DELETE … RETURNING` would merge the read
and delete into one round trip but adds no correctness — it is an optimization, not a gap.

### 4.4 `oauth_clients` — dynamically-registered OAuth clients

A client registered via OAuth Dynamic Client Registration (DCR). The full client record lives in
`data`; `issuedAt` is a separate indexed column so aged clients can be swept — DCR is
unauthenticated, so clients must not accumulate unbounded.

| Column | Type | Notes |
|---|---|---|
| `clientId` | `varchar` **PK** | Client identifier |
| `data` | `text` (`simple-json`) | Full client record (JSON) |
| `issuedAt` | `bigint` (ms) | **indexed**; used by the prune sweep |

**Indexes:** PK(`clientId`), `IDX(issuedAt)`.

### 4.5 `wc_kv` — WalletConnect key-value store

WalletConnect's own `IKeyValueStorage`, backed by Postgres via `PgKvStorage`
(`src/wallet/pg-kv-storage.ts`) so relay sessions and their signers survive a restart. Values are
arbitrary WalletConnect JSON (sessions, keychain, subscriptions).

| Column | Type | Notes |
|---|---|---|
| `key` | `varchar` **PK** | WalletConnect storage key |
| `value` | `text` (`simple-json`), **nullable** | Arbitrary WC JSON, optionally encrypted (below) |

**Indexes:** PK(`key`).

**Encryption at rest.** `wc_kv.value` is the one column that carries key material, so it is the
one column with application-level encryption — see [§7](#7-encryption) for the full details. In
short: with `WC_ENCRYPTION_KEY` set, each value is AES-256-GCM envelope-encrypted; without it,
the server **refuses to start** in wallet mode unless `WC_ALLOW_PLAINTEXT=true` explicitly
accepts plaintext storage (non-production only).

---

## 5. Conventions

- **Timestamps** — every time column is `bigint` epoch-**milliseconds**, read back as a JS
  `number`. Comparisons use `expiresAt <= Date.now()` throughout.
- **Hashing** — `tokenHash` and `codeHash` are SHA-256 **hex** (64 chars). Bearer tokens and
  authorization codes are hashed with `hashToken()` before they ever touch the database.
- **Structured data** — `simple-json` (objects) and `simple-array` (string lists) serialise to
  `text` for SQLite portability; they are **not** queryable at the DB level.
- **No foreign keys** — relationships are by convention; cascades are performed in code.
- **Nullability** — only `wc_kv.value` is nullable; every other column is `NOT NULL`.

---

## 6. Data lifecycle & retention

**Creation.** A sign-in ceremony writes a `pairings` row (and WalletConnect populates `wc_kv`);
the OAuth flow writes an `auth_codes` row, which is consumed to mint `grants` (access + refresh).
DCR writes `oauth_clients` rows.

**Expiry is enforced two ways:**

1. **Lazy, on read.** `getGrant` / `getPairing` delete the row and return `undefined` if
   `expiresAt <= now`, so an expired record is never served even before the sweep runs.
2. **Periodic prune** (`SessionStore.prune`, on the same interval as the in-memory prunes) issues
   indexed deletes:
   - `grants`, `pairings`, `auth_codes` where `expiresAt <= now`
   - `oauth_clients` where `issuedAt <= now − clientTtlMs` (**default 30 days**)
   - in-memory claimed-code hashes older than 10 minutes

**Cascade on wallet disconnect.** `purgeByTopic(topic)` (called on WalletConnect `session_delete`)
deletes every `pairings` row on that topic **and** the `grants` and unredeemed `auth_codes` that
reference those `pairingRef`s — so a disconnected wallet immediately invalidates its tokens and
any authorization code still in flight through the OAuth exchange. As a second gate, token
minting (`issueTokens`) re-checks that the pairing row still exists, so even a code consumed
concurrently with a disconnect cannot mint tokens for a dead session.

**Explicitly NOT stored.** Pending signing requests are deliberately kept **in memory only** (they
are short-lived and hold transaction bytes); sign-in nonces and browser-ceremony state are
likewise in-memory. A restart therefore drops in-flight approvals but preserves tokens and wallet
sessions. This is an accepted single-instance design decision.

---

## 7. Encryption

Encryption here is **narrow and targeted**, not "the whole database is encrypted." Know exactly
what is protected and how.

### 7.1 At rest — `wc_kv` values (application-level)

The **only** application-encrypted data is `wc_kv.value` — WalletConnect's session keychain (relay
symmetric keys, sessions, subscriptions). When `WC_ENCRYPTION_KEY` is set, `PgKvStorage`
envelope-encrypts **every** value it writes (`src/crypto/envelope.ts`).

| Property | Value |
|---|---|
| Cipher | **AES-256-GCM** |
| IV | random **96-bit** per value |
| Integrity | GCM auth tag — a wrong key or altered ciphertext makes decrypt **throw**, not return garbage |
| Key derivation | `scrypt(passphrase, salt, 32 bytes)` |
| Passphrase | `WC_ENCRYPTION_KEY` (inject from a secrets manager); **min 32 chars, validated at boot** |
| Salt | **static**: `hedera-mcp-wc-kv:v1` |
| Format | `enc:v1:<iv>:<tag>:<data>` (all base64); the row stores `{ "enc": "…" }` |
| When unset | server **refuses to start** in wallet mode; `WC_ALLOW_PLAINTEXT=true` opts into plaintext (non-production only, warned at boot and surfaced as `wcKv: "plaintext"` on `/readyz`) |

Backward-compatible: unprefixed (plaintext) rows are read as-is and re-encrypted on the next write,
so enabling the key needs no migration. **Fail-closed:** an `enc:v1:` row read with no key raises
an error rather than returning ciphertext.

### 7.2 Hashed, not encrypted — tokens & codes

`grants.tokenHash` and `auth_codes.codeHash` are **SHA-256 hashes, not ciphertext** — deliberately.
Hashing is one-way, so a leaked database cannot be reversed into a usable bearer token or
authorization code; encrypting them would be *weaker* (reversible with the key). `codeChallenge` is
likewise a PKCE hash of the client's verifier. There is nothing to decrypt for these columns.

### 7.3 Plaintext columns

Everything else is stored in the clear: `accountId`, `network`, `topic`, `pairingRef`, `clientId`,
`redirectUri`, `scopes`, the OAuth-client `data` blob, and all timestamps. None is a signing secret
— the server holds no Hedera keys — so a database leak enables *prompt initiation* at most, never
signing. If your threat model needs these confidential (e.g. account-linkage privacy), cover them
with DB-level / volume encryption (§7.5), which application-level encryption does not replace.

### 7.4 Key management & rotation

- **One key, no key-id.** The `v1` prefix versions the *format*, not the key — no key identifier is
  stored. Changing `WC_ENCRYPTION_KEY` therefore makes existing `enc:v1:` rows undecryptable (GCM
  auth fails), so **key rotation is not supported** without a re-encryption pass. In practice:
  clear `wc_kv` (drops relay sessions; wallets re-pair) when rotating.
- **Static salt.** scrypt uses a fixed, non-secret salt, so the derived key is deterministic per
  passphrase and the passphrase must carry the entropy itself. This is **enforced at boot**: a
  `WC_ENCRYPTION_KEY` shorter than 32 characters is rejected (`assertWcEncryptionConfig`,
  `src/config.ts`). Generate it with `openssl rand -base64 32`. Sourcing the key from a KMS is a
  planned follow-up; a key-id-bearing envelope format (`enc:v2:<keyid>:…`) enabling per-row
  decrypt-with-old / re-encrypt-with-new rotation is the planned stepping stone to it.

### 7.5 In transit & at the volume

- **App ↔ Postgres:** not handled by the application. Enable TLS on the connection
  (`?sslmode=require` in `DATABASE_URL`) whenever the database is remote.
- **DB-level / volume encryption** (filesystem, Postgres TDE, cloud-managed at-rest): complementary
  to §7.1 and the appropriate control for the plaintext columns in §7.3. `SECURITY.md` recommends
  running with both.

---

## 8. Security properties (summary)

- **No replayable secrets at rest.** Tokens and authorization codes are stored only as SHA-256
  hashes; a database leak cannot be replayed as a bearer token or redeemed as a code.
- **WalletConnect relay keys** in `wc_kv` are the one piece of key material stored; they are
  encrypted at rest with `WC_ENCRYPTION_KEY`, which wallet mode **requires** at boot (full detail
  in §7). Even in plaintext (explicit `WC_ALLOW_PLAINTEXT` opt-out), a leaked database allows
  *prompt initiation*, never signing — the server holds no Hedera signing keys.
- **Single-use codes** are protected against concurrent redemption, including across processes
  (see §4.3).
- **Single-instance enforced.** A boot-time Postgres advisory lock refuses a second replica
  against the same database (see the note at the top of this document).
- **Unbounded-growth guards.** Unauthenticated DCR clients are age-pruned and `/register` is
  rate-limited per-IP at the HTTP layer; expired grants/codes/pairings are swept.

Operational guidance (restrict DB access, private network, set `WC_ENCRYPTION_KEY`) lives in
[`../SECURITY.md`](../SECURITY.md).

---

## 9. Local setup

```bash
docker compose up -d      # Postgres 17 on localhost:5433 (user/pass/db: hedera_mcp)
npm run migration:run     # create the schema
```

Default connection string (matches `docker-compose.yml`):

```
postgresql://hedera_mcp:hedera_mcp@localhost:5433/hedera_mcp
```

Tests need no database — they run against in-memory SQLite with `synchronize: true`.

---

## 10. Deployment constraints

These follow from the single-instance advisory lock (see the note at the top) and are
**load-bearing** — getting them wrong either wedges a deploy or silently disables the guarantee.

- **Deploy stop-then-start, never start-before-stop.** The outgoing process holds the lock until
  its session ends, so an overlapping deploy strategy cannot converge: the incoming process
  cannot become ready, so the outgoing one is never terminated. On Kubernetes use
  `strategy: Recreate`, not the default `RollingUpdate`. Boot retries a few times over several
  seconds, which covers an ordinary restart's drain window but not an overlap by design.
- **`DATABASE_URL` must be a direct connection, not a transaction-pooling proxy.** Session-level
  advisory locks are tied to a backend session. Behind PgBouncer in transaction mode the lock
  lands on an arbitrary pooled backend, which makes the guard either silently ineffective (two
  instances both "acquire" it) or permanently stuck (a lock leaks onto a pooled backend). Session
  pooling or a direct connection is required.
- **Host loss can delay a replacement boot.** A `SIGKILL`ed process releases the lock promptly
  (the kernel closes the socket). A hard host death or network partition leaves the Postgres
  session lingering until TCP keepalives expire — on Linux defaults, potentially hours. Tune
  `tcp_keepalives_idle`/`_interval`/`_count` on the Postgres server if fast failover matters.
- **Keep `/readyz` on an internal listener or LB-internal path.** It reports `wcKv: "plaintext"`
  when the `WC_ALLOW_PLAINTEXT` opt-out is active (§7.1), which is useful monitoring signal but
  also unauthenticated posture disclosure if reachable from the internet.

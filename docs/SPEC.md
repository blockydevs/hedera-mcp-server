# Hedera MCP Server — Specification

Authoritative description of the system **as built**. For the database layer in depth, see
[`DATABASE.md`](DATABASE.md).

---

## 1. Purpose

An **MCP (Model Context Protocol) server** that lets an AI agent submit Hedera transactions
which **the user approves and signs in their own wallet**, over WalletConnect v2 / HIP-820.

The server is **non-custodial**: in `RETURN_BYTES` mode it holds no Hedera operator key and
never submits a transaction itself — the wallet signs *and* broadcasts. The wallet approval is
therefore the real authorization boundary; a fully-compromised server can build deceptive
transactions and spam prompts, but can move no funds without the user approving what their
wallet decodes and displays.

Two run modes:

- **Wallet mode** (`WALLETCONNECT_PROJECT_ID` + `PUBLIC_URL` set): full OAuth 2.1 + wallet
  signing, Postgres-backed.
- **Dev mode** (neither set): an unauthenticated `RETURN_BYTES` server for local development,
  with the account supplied by an `x-hedera-account-id` header. The server refuses to bind a
  non-loopback host in this mode unless `ALLOW_INSECURE=true`.

---

## 2. Architecture

```
NestJS app (platform-express, via ExpressAdapter over the MCP SDK's Express instance)
├─ AppModule ................. DI graph; async factories carry startup lifecycle
│   ├─ DATA_SOURCE ........... TypeORM Postgres connection (null in dev)
│   ├─ SESSION_STORE ......... OAuth/session repository
│   ├─ WALLET_APPROVER ....... WalletConnect dApp client (restores sessions on boot)
│   ├─ OAUTH_PROVIDER ........ OAuth 2.1 server whose login is a wallet
│   ├─ SIGNING_REGISTRY ...... async signing state machine + mirror-confirm
│   ├─ INTENT_REGISTRY ....... structured intent captured at build time
│   └─ APPROVAL_HOOK ......... agent-kit postCoreActionHook (memo + intent)
├─ configureMcpHttp(app, deps) ... wires the HTTP surface onto Express:
│     rate limiter → request-log → origin HMAC → bearer-auth → /mcp routes,
│     the OAuth router, the /connect and /approve pages, and the prune/eviction intervals
└─ createSigningToolkit(...) ..... the MCP server: write tools auto-deliver; wallet tools added

Postgres (TypeORM, migrations-owned schema)
  grants, pairings, auth_codes, oauth_clients (SessionStore; tokens/codes hashed)
  wc_kv (WalletConnect's own store; values envelope-encrypted at rest)

In-memory (ephemeral by design — single-instance):
  transports, sessionAccounts, sessionLastSeen, signing requests, intents, ceremonies, nonces
```

The MCP SDK is Express-native; NestJS owns the dependency graph and lifecycle while the request
surface runs on the SDK's Express app. Ephemeral state ties the server to a **single instance**
(see §11).

---

## 3. Trust & security model

- **No operator key.** The server builds and freezes transactions but never signs or submits.
  Enforced two ways in `src/options.ts`: `RETURN_BYTES` is the **default** when `--agent-mode`
  is omitted (the agent kit resolves an unset mode to its *executing* strategy, so relying on
  the flag being passed would fail open), and the flag is validated against this server's own
  supported list rather than the kit's `AgentMode` enum — which contains executing modes and
  grows with upstream releases.
- **Wallet sessions run in `CUSTOM_RETURN_BYTES`**, set internally (never operator-selectable)
  when a verified wallet session exists, with a `WalletDeliveryStrategy` on the context. The
  strategy freezes the transaction and hands it to `buildApprovalResponse`, so delivery is the
  tools' own terminal step. Both custom modes read the same `transactionStrategy` slot, so the
  strategy refuses to run in `CUSTOM_EXECUTE_TX` — an approval-shaped strategy must never be
  reachable from an executing mode.
- **The wallet approval is the only authorization.** For fully-decodable types (transfers, HCS
  messages) the wallet display is the user's independent check; for opaque types (contract
  calls, file ops) the response carries `walletVerifiable: false` and the built transaction gets
  a caution **memo**.
- **Identity = a verified Hedera account.** In wallet mode the account is the OAuth token's
  subject, proven by a signed sign-in nonce checked against the account's mirror-node key —
  never taken from client input.
- **Defence in depth on the bytes.** Transaction bytes travel through the model's context, so
  before delivery the server re-checks: the payer is the paired account, no transfer leg debits
  a foreign account (including inside a `ScheduleCreate` wrapper), and the transfer is not an
  empty/self no-op.
- **Secrets at rest.** OAuth tokens and auth codes are stored SHA-256-hashed; WalletConnect
  session symmetric keys in `wc_kv` are AES-256-GCM envelope-encrypted with `WC_ENCRYPTION_KEY`,
  which wallet mode requires (`WC_ALLOW_PLAINTEXT=true` is an explicit dev-only opt-out). A leaked DB permits prompt *initiation*, never signing.
- **Resource governance.** Per-IP rate limiting, a concurrent-session cap, idle-session
  eviction, and a per-account concurrent-approval quota.
- **Transport.** Plaintext HTTP by design — **must** run behind a TLS-terminating proxy;
  refuses an unauthenticated non-loopback bind.

---

## 4. Authentication — the wallet is the login

The server is an OAuth 2.1 authorization server (the MCP SDK's `mcpAuthRouter` provides
`/authorize`, `/token`, `/register`, `/revoke`, and metadata; PKCE mandatory). The
`/authorize` "login form" is a wallet ceremony:

```
1. Client hits /mcp unauthenticated → 401 + WWW-Authenticate
2. Client runs OAuth 2.1 auth-code + PKCE → opens /authorize → redirects to /connect
3. /connect: pair a wallet (browser-extension button or WalletConnect QR)
4. Server sends hedera_signMessage { nonce, domain, issued-at } over the fresh session
5. User approves the sign-in message (moves no funds)
6. Server verifies the signature against the account's key (mirror node) — single-key only
7. → authorization code → token exchange (PKCE + redirect_uri checked)
8. Access token subject = hedera:<network>:0.0.x, bound 1:1 to the WC pairing
```

Consequences: token ↔ pairing is 1:1 (a device = a token = a pairing); token lifetime never
exceeds the WC session; a wallet-side `session_delete`/`session_expire` purges the pairing and
its grants immediately; refresh fails once the session dies → tools return `needs_reauth`.
Sign-in nonces are single-use, domain- and issued-at-bound, ≤5 min. The `/connect` page is
anti-clickjacking (`X-Frame-Options: DENY` + CSP) and CSRF-checked on `POST /connect/start`.

**Known limitation:** sign-in verifies a single-key account; threshold/key-list accounts are
not supported yet.

---

## 5. Transaction lifecycle

Async two-tool surface so nothing blocks on a human (MCP clients cap tool calls near ~60 s):

```
write_tool(args)  →  builds + freezes + DELIVERS to the wallet  →  { requestId, status, summary, walletVerifiable, walletKind, approveUrl?, hint }
check_signing_status({ requestId, waitMs? })  →  long-polls until resolved  →  status (+ transactionId, hashscanUrl)
```

Status machine (in `SigningRequestRegistry`):

```
awaiting_approval ──user approves──▶ confirming ──mirror OK──▶ executed
        │                                 │
        │                                 └──mirror fail──▶ failed
        ├──TTL lapses──▶ expired          └──not found ──▶ expired
        ├──user declines──▶ rejected
        └──session dies──▶ needs_reauth
```

Load-bearing details:

- **`executed` requires mirror-node confirmation**, not the wallet's word. After the wallet
  returns a `transactionId`, the request enters `confirming` and the server polls the mirror
  node (bounded: attempts × delay, each call timeout-capped) before reporting `executed`. This
  prevents a stale-window approval being reported as success for a transaction that never
  landed.
- **A late-but-real broadcast is honoured.** If the request already flipped to `expired`
  (TTL) or `needs_reauth` (racing `session_delete`) while the broadcast was in flight, the
  returned `transactionId` is still recorded and the mirror node decides — otherwise a real
  transfer would be dropped and the agent told to retry, landing it twice.
- **Request TTL = ~180 s**, matching Hedera's transaction-validity window.
- **`check_signing_status` long-polls** (default ~45 s, cap 55 s, under the ~60 s client
  timeout): one call blocks until the user acts, so the agent needn't poll in a loop or ask
  the user "done?". `waitMs:0` for an instant check.
- Requests are in-memory and hold transaction bytes; they are never persisted. A restart
  drops them → `expired`.

---

## 6. Tool surface

```
wallet_status()                    → { accountId, network, sessionExpiry, walletKind, walletName? }
<write>_tool(args)                 → { requestId, status, summary, walletVerifiable, walletKind, approveUrl?, hint }
check_signing_status({requestId})  → { status, transactionId?, hashscanUrl?, nextStep }
sign_with_wallet({ bytes })        → same envelope — raw-bytes escape hatch (write tools auto-deliver)
*_query_tool(...)                  → data   // reads ride along unchanged
```

- **Write tools auto-deliver.** A custom toolkit (`createSigningToolkit`) wraps each Agent-Kit
  write tool: it runs the tool to get the frozen bytes, then delivers them to the wallet and
  returns a `requestId` — one call, no bytes through the model. Query tools and dev mode pass
  through unchanged.
- **The result says where to approve.** Neither wallet opens by itself, so `walletKind`
  (`extension` | `mobile`) and `hint` tell the agent what to tell the user first ("waiting for
  your approval in your HashPack browser extension" / "in the HashPack app on your phone"), then
  to call `check_signing_status`. It is read per call from the WC session's peer metadata
  (`wallet-presence.ts`): a `chrome-extension://` url is `extension`; any other url from a tested wallet (HashPack,
  Kabila Wallet) is `mobile`; an untested or unknown wallet is `extension`.
- **`GET /approve?ext=<extension id>`** — for an extension wallet, `approveUrl` points here; an
  agent with a shell opens it in the default browser and the page brings up that extension's
  approval window. Static, stateless, unauthenticated (rate-limited, CSP-locked); it only talks
  to the extension over postMessage — the transaction is already in the wallet. Kabila only
  opens its window from a real click, so its link carries `&click=1`: the page still tries
  the open message once, but stays open (the wallet never says whether it opened) and the
  "Open Kabila Wallet" button is the fallback. The button
  shows the wallet's name and the icon it announced (inline image or https only; the page's
  CSP allows `img-src 'self' data: https:`).
- **Structured intent + memo via a hook.** `postCoreActionHook` fires on the *unfrozen*
  transaction (before the freeze), so it can stamp a memo on opaque types and record a faithful
  summary — without modifying any tool.
- **Tool descriptions are sanitised** at registration to strip upstream "tool-poisoning"
  secrecy/imperative directives; `tools.listChanged` is off (no mid-session redefinition).
- **The sender is never a parameter** — it is the paired account; the payer, foreign-debit, and
  meaningful-transfer checks run on every delivery regardless of entry point.

---

## 7. Data model (Postgres, TypeORM)

> Full schema — columns, types, indexes, lifecycle, and portability rules — in
> [`DATABASE.md`](DATABASE.md). The table below is the summary.

| Table | Key | Holds | At rest |
|---|---|---|---|
| `grants` | `tokenHash` (sha256) | access/refresh grant → pairing, account, scopes, expiry | token hashed |
| `pairings` | `pairingRef` | WC topic, account, network, expiry | — |
| `auth_codes` | `codeHash` (sha256) | client, redirect, PKCE challenge, pairing, account, expiry | code hashed |
| `oauth_clients` | `clientId` | DCR client record + issuedAt (for GC) | — |
| `wc_kv` | `key` | WalletConnect's session store | symKeys AES-256-GCM |

Timestamps are `bigint` epoch-ms via a portable transformer (Postgres returns bigint as string;
coerced to number). JSON via `simple-json`. Schema is owned by **migrations**
(`DB_SYNCHRONIZE` off by default); `npm run migration:run`. Expired records are swept by an
indexed prune on an interval; auth-code single-use has an in-process claim + a `DELETE …
affected=1` check for cross-process safety.

---

## 8. Configuration

All via env (see `.env.example`). Key vars:

| Var | Effect |
|---|---|
| `WALLETCONNECT_PROJECT_ID`, `PUBLIC_URL` | enable wallet mode (both or neither; half fails at startup) |
| `DATABASE_URL` | Postgres (required in wallet mode) |
| `DB_SYNCHRONIZE` (default false), `DB_MIGRATIONS_RUN` | schema management |
| `WC_ENCRYPTION_KEY` | encrypt WC session keys at rest (required in wallet mode, min 32 chars) |
| `WC_ALLOW_PLAINTEXT` | dev-only opt-out of `wc_kv` encryption |
| `MAX_SESSIONS`, `RATE_LIMIT_PER_MINUTE`, `MAX_CONCURRENT_APPROVALS`, `TRUST_PROXY_HOPS` | resource governance |
| `SIGN_REQUEST_TTL_MS`, `SIGNIN_NONCE_TTL_MS`, `CEREMONY_TTL_MS`, `ACCESS_/REFRESH_TOKEN_TTL_MS` | lifetimes (defaults in `src/config.ts`; not clamped — an issued token expiry is additionally bounded by its pairing in `provider.ts`) |
| `ALLOW_INSECURE` | override the non-loopback-bind guard (never in prod) |
| `LOG_LEVEL`, `LOG_PRETTY` | structured JSON logs (or human dev lines) |
| `ORIGIN_AUTH_VERIFICATION_ENABLED`, `ORIGIN_AUTH_SECRET_FILE_PATH` | HMAC origin gate: a trusted edge signs method, path, timestamp, nonce and body hash |

Config validation runs at startup and fails closed on ambiguous/insecure combinations.

---

## 9. Observability

Structured JSON logging (`src/logger.ts`): one object per line `{ts, level, msg, ...fields}`;
warn/error to stderr, info/debug to stdout; `LOG_LEVEL` gates verbosity; `LOG_PRETTY` for dev.
A per-request `reqId` (+ truncated session id) correlates the HTTP lifecycle; the signing
registry logs every transition keyed by `requestId`+`accountId`, so one signing request is
traceable across its async hops (inbound → delivery → broadcast → mirror confirm). Session ids
are logged truncated (bearer-equivalent).

**Health probes:** `GET /healthz` (liveness — 200 whenever the process is up) and `GET /readyz`
(readiness — round-trips the database with `SELECT 1`, 200 `ready` / 503 `unavailable`; in dev
mode with no DB it collapses to liveness). Both are mounted ahead of rate-limiting, auth, and the
request logger, so orchestrator probes are never gated or logged as spam.

---

## 10. Deployment

- **Docker** multi-stage, runs as non-root `node`, `dist/main.js` entrypoint.
- **Postgres** required; run migrations as a deploy step (`npm run migration:run`) or set
  `DB_MIGRATIONS_RUN=true` (single-instance).
- **Behind a TLS-terminating reverse proxy**, always; set `TRUST_PROXY_HOPS`.
- Vendored WalletConnect bundle (`dist/vendor/…`) is built by `scripts/build-vendor.mjs` (the
  package is unbundled ESM Node can't load); a boot + smoke-test assertion guards the
  library-internals bypass used to inject the Postgres storage.

---

## 11. Known limitations / non-goals

- **Single instance (by design).** In-memory state (transports, ceremonies, nonces, signing
  requests, quota counters) and WalletConnect's single-relay-ownership mean the deploy is **one
  replica**. This is an accepted design decision, not a defect; a
  restart drops in-flight signing requests (WalletConnect sessions persist via Postgres). Multi-
  instance HA is explicitly a non-goal.
- **Dependency advisories:** a few moderate transitive advisories remain, pinned by the
  upstream Hedera SDK stack; run `npm audit` for the current list.
- **Single-key accounts only** at sign-in. Exercised on **testnet**; mainnet is a per-sign-in
  parameter and has not been tested end to end.
- **No spend policies** (per-tx / per-day caps, recipient allowlists) and **no append-only audit
  log** — out of scope; the wallet approval prompt is the spending control, and structured logs
  serve forensics.
- Contract calls and other opaque types are delivered with `walletVerifiable: false` + a memo,
  not decoded.

---

## 12. Testing

Unit and integration tests run on vitest (`npm test`). Store/provider/envelope run against in-memory sqlite
(entities are DB-portable). Pure security-critical logic (transaction guards, nonce lifecycle,
the signing state machine incl. the double-spend and long-poll paths, envelope crypto) is well
covered; the `server/configure.ts` request surface has an integration test
(`test/mcp-http.test.ts` — the `/mcp` POST/GET/DELETE lifecycle, session-account binding, header
validation, session cap). The WalletConnect handshake and `hedera_signAndExecuteTransaction`
round trip need a real wallet and are tested manually on testnet. The vendored bundle is loaded
in `test/dapp-connector-init.test.ts` to catch a library bump. Coverage gap: the `main.ts` bootstrap has no
integration test.

---

## 13. Implementation traps

Two non-obvious behaviours that any change in these areas must respect:

- **The Hedera SDK ships minified**, so `transaction.constructor.name` returns mangled names (a
  contract call reports as `"i"`). Type dispatch must use `instanceof`, never name matching —
  name matching fails open and would mark contract calls as wallet-verifiable. See
  `isWalletVerifiable()` and its regression test.
- **`DAppConnector.request()` routes by account, not session.** It resolves signers with
  `signers.find(s => s.getAccountId() === accountId)`, so when one account is paired from two
  machines a sign request can reach the wrong device's wallet. `src/wallet/approver.ts` routes by
  **session topic** instead.

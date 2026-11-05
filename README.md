# Hedera MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets AI agents
work with the [Hedera](https://hedera.com) network. It speaks MCP over **Streamable HTTP** and
exposes the [Hedera Agent Kit](https://github.com/hashgraph/hedera-agent-kit-js) toolset, so an
LLM client (Claude, Cursor, VS Code, Codex, …) can query accounts, tokens and topics, and prepare
transactions on testnet or mainnet.

The server is **non-custodial**: it never holds a Hedera private key. It runs in one of two modes:

- **Dev mode (default, no setup).** Write tools return **unsigned transaction bytes** for the
  caller to sign and submit. The account is taken from an `x-hedera-account-id` request header.
  No database, no OAuth.
- **Wallet signing (optional).** The server becomes an OAuth 2.1 authorization server whose login
  is the user's wallet. Each write tool sends the transaction to that wallet over WalletConnect
  ([HIP-820](https://hips.hedera.com/hip/hip-820)) for the user to approve; the wallet signs and
  broadcasts. Needs Postgres and a WalletConnect project ID. See
  [Wallet Signing](#wallet-signing-non-custodial).

> [!TIP]
> **Just want a plain local Hedera MCP server, without wallet sign-in?** The Hedera Agent Kit
> ships a runnable example with the same toolset:
> [`examples/modelcontextprotocol`](https://github.com/hashgraph/hedera-agent-kit-js/tree/main/examples/modelcontextprotocol).
> Its HTTP server needs no keys; its stdio server takes your account's private key
> (`HEDERA_OPERATOR_KEY`) and signs transactions itself, so use a testnet account. To build your
> own server, use the library
> [`@hashgraph/hedera-agent-kit-mcp`](https://www.npmjs.com/package/@hashgraph/hedera-agent-kit-mcp).

## What it does

Out of the box the server registers 44 Hedera Agent Kit tools:

| Area | Examples |
| --- | --- |
| Accounts & HBAR | `create_account_tool`, `update_account_tool`, `transfer_hbar_tool`, HBAR allowances |
| Hedera Token Service | create / mint / airdrop / transfer fungible and non-fungible tokens, associate / dissociate, token and NFT allowances |
| Consensus Service | `create_topic_tool`, `submit_topic_message_tool`, `update_topic_tool`, `delete_topic_tool` |
| EVM | `create_erc20_tool`, `transfer_erc20_tool`, `create_erc721_tool`, `mint_erc721_tool`, `transfer_erc721_tool` |
| Scheduled transactions | `sign_schedule_transaction_tool`, `schedule_delete_tool` |
| Queries (mirror node) | HBAR and token balances, account, token, topic and contract info, topic messages, pending airdrops, transaction records, exchange rate |

Use `--tools` to expose a subset. In wallet mode, three tools are added
(`wallet_status`, `check_signing_status`, `sign_with_wallet`).

## Run it locally

### Prerequisites

- **Node.js 24.22.1 or later 24.x** (see [`.nvmrc`](.nvmrc); earlier 24.x builds are vulnerable
  to [CVE-2026-111497](https://www.aikido.dev/blog/node2shell-nodejs-brotli-rce-cve-2026-111497))
- A Hedera account ID to build transactions for. A free testnet account is available from the
  [Hedera Portal](https://portal.hedera.com).

### Quick start (dev mode)

```bash
git clone https://github.com/blockydevs/hedera-mcp-server.git
cd hedera-mcp-server
nvm use            # optional, picks up .nvmrc
npm install
npm run build
npm start          # = node dist/main.js --agent-mode=returnBytes (testnet)
```

The server listens on `http://localhost:3001/mcp`. Check it with
`curl http://localhost:3001/healthz` → `{"status":"ok"}`.

### Connect an MCP client

Point any MCP client that supports Streamable HTTP at the server and pass your account ID in the
`x-hedera-account-id` header. For example, with Claude Code:

```bash
claude mcp add --transport http hedera http://localhost:3001/mcp \
  --header "x-hedera-account-id: 0.0.YOUR_ACCOUNT_ID"
```

or in a client's JSON config:

```json
{
  "mcpServers": {
    "hedera": {
      "url": "http://localhost:3001/mcp",
      "headers": {
        "x-hedera-account-id": "0.0.YOUR_ACCOUNT_ID"
      }
    }
  }
}
```

To poke at the tools without an LLM, run the
[MCP Inspector](https://github.com/modelcontextprotocol/inspector)
(`npx @modelcontextprotocol/inspector`), choose **Streamable HTTP**, enter the URL above and add
the header.

### Run with Docker

```bash
docker build -t hedera-mcp .
docker run --rm -p 3001:3001 \
  -e HEDERA_HTTP_HOST=0.0.0.0 -e ALLOW_INSECURE=true \
  hedera-mcp                      # add --ledger-id=mainnet to override the testnet default
```

Inside a container the server must bind `0.0.0.0` to be reachable through the published port, and
an unauthenticated non-loopback bind is refused unless `ALLOW_INSECURE=true`. That is fine on your
own machine; never deploy it that way (see [Security notes](#security-notes)).

The image's entrypoint is `node dist/main.js --agent-mode=returnBytes` with a default
`CMD ["--ledger-id=testnet"]`.

### Quick start — wallet signing (non-custodial)

The full path to a running wallet-signing server, where every transaction is approved in the
user's own wallet. See [Wallet Signing](#wallet-signing-non-custodial) below for how it works.

1. **Configure.** Copy the sample env and fill it in (`dist/main.js` auto-loads `.env`):
   ```bash
   cp .env.example .env
   ```
   Set at least these in `.env`:
   ```bash
   WALLETCONNECT_PROJECT_ID="<your id from https://cloud.reown.com>"
   PUBLIC_URL="https://mcp.example.com"          # public HTTPS origin of THIS server
   WC_ENCRYPTION_KEY="<output of: openssl rand -base64 32>"  # encrypts WC session keys at rest
   DATABASE_URL="postgresql://hedera_mcp:hedera_mcp@localhost:5433/hedera_mcp"  # matches docker compose
   ```
   > `.env` values are not shell-expanded: run `openssl rand -base64 32` and paste its output.
   > Setting exactly one of `WALLETCONNECT_PROJECT_ID` / `PUBLIC_URL` fails at startup — set both
   > (wallet mode) or neither (dev mode). `WC_ENCRYPTION_KEY` is required in wallet mode (min 32
   > chars); without it the server refuses to start, unless `WC_ALLOW_PLAINTEXT=true` explicitly
   > accepts unencrypted session-key storage (non-production only).

2. **Start Postgres** (local dev):
   ```bash
   docker compose up -d
   ```

3. **Install, build, and run migrations:**
   ```bash
   npm install
   npm run build
   npm run migration:run
   ```

4. **Run the server:**
   ```bash
   node dist/main.js --agent-mode=returnBytes --ledger-id=testnet
   ```
   To expose it externally, set `HEDERA_HTTP_HOST=0.0.0.0` and put it **behind a TLS-terminating
   reverse proxy** — a non-loopback bind without authentication is refused at startup.

5. **Connect a client.** Point your MCP client at `PUBLIC_URL` + `/mcp`. On the first call the
   server returns `401`, and the client runs the OAuth 2.1 + wallet sign-in flow automatically
   (browser-extension button or WalletConnect QR). No `x-hedera-account-id` header is used — the
   account comes from the wallet-verified token.

### Health checks

Two unauthenticated probes for orchestrators (mounted ahead of rate-limiting and auth, so they
are never gated):

- `GET /healthz` — liveness; returns `200 {"status":"ok"}` whenever the process is up.
- `GET /readyz` — readiness; round-trips the database (`200 {"status":"ready"}`, or
  `503 {"status":"unavailable"}` if it can't). In dev mode (no database) it collapses to liveness.

### Configuration

The server can be configured using environment variables:

- `HEDERA_HTTP_HOST` (default: `localhost`)
- `HEDERA_HTTP_PORT` (default: `3001`)
- `HEDERA_HTTP_ALLOWED_HOSTS` (optional, comma-separated allowlist for `Host` header)
- `ORIGIN_AUTH_VERIFICATION_ENABLED` (default: `false`, enables HMAC origin verification)
- `ORIGIN_AUTH_SECRET_FILE_PATH` (path to a file containing the shared HMAC secret)
- `LOG_LEVEL` (default: `info`; `silent` disables logging) and `LOG_PRETTY` (default: `false`,
  human-readable instead of one-JSON-per-line)
- `DAPP_NAME`, `DAPP_DESCRIPTION`, `DAPP_ICON_URL` - WalletConnect dApp metadata shown to the wallet
- TTL tuning knobs (ms): `SIGN_REQUEST_TTL_MS` (~180s), `SIGNIN_NONCE_TTL_MS`, `CEREMONY_TTL_MS`,
  `ACCESS_TOKEN_TTL_MS`, `REFRESH_TOKEN_TTL_MS`

See [`.env.example`](.env.example) for the complete, annotated list of environment variables
(wallet signing, encryption at rest, resource governance, database).

### Optional Origin Verification (HMAC)

When `ORIGIN_AUTH_VERIFICATION_ENABLED=true`, the server verifies that each request was signed by a trusted edge (e.g. Cloudflare Worker) using HMAC-SHA256. Required headers:

- `X-Origin-Timestamp` — millisecond timestamp (must be within 30 seconds of server time)
- `X-Origin-Nonce` — unique value per request (replay protection)
- `X-Origin-Signature` — hex-encoded HMAC-SHA256 of the canonical string:

```
{method}\n{path}\n{timestamp}\n{nonce}\n{sha256Hex(body)}
```

The shared secret is loaded from the file at `ORIGIN_AUTH_SECRET_FILE_PATH`.

- Missing or invalid signature returns `401 Unauthorized`
- When `ORIGIN_AUTH_VERIFICATION_ENABLED=false`, requests are allowed without this check

The gate covers the whole request surface: `/mcp`, the OAuth endpoints (`/authorize`, `/token`,
`/register`, `/.well-known/*`), the `/connect` sign-in page, and any unmatched path. The only
exemptions are `/healthz` and `/readyz`, which orchestrators call against the container directly
rather than through the edge, so they cannot carry a signature.

In production, the edge proxy generates these headers. For local testing you must compute the HMAC yourself.

Example setup:

```bash
echo "my-super-secret" > /tmp/origin-auth-secret.txt
export ORIGIN_AUTH_VERIFICATION_ENABLED=true
export ORIGIN_AUTH_SECRET_FILE_PATH=/tmp/origin-auth-secret.txt
```

You can also override the port and ledger via CLI:

```bash
node dist/main.js --agent-mode=returnBytes --port=8080 --ledger-id=mainnet
```

### Supported Arguments

- `--agent-mode`: `returnBytes` only, and the default when the flag is omitted. This server is
  non-custodial and holds no operator key, so executing modes (the agent kit's `autonomous`, and
  its `customExecuteTx`) are **refused at startup** rather than accepted and failing later.
- `--ledger-id`: `testnet` (default) or `mainnet`.
- `--host`: Interface to bind (default: `localhost`; also settable via `HEDERA_HTTP_HOST`). A
  non-loopback host is refused at startup unless the server is authenticated or `ALLOW_INSECURE=true`.
- `--port`: Port to listen on (default: `3001`).
- `--tools`: Comma-separated list of tools to enable (default: all).
- `--account-id`, `--public-key`: dev-mode account binding (ignored in wallet mode, where the
  account comes from the bearer token).

## Agent Mode: RETURN_BYTES

In this mode, the MCP server returns the unsigned transaction bytes instead of executing them. This ensures the server remains stateless and does not require operator credentials.

> [!IMPORTANT]
> Requesters must provide the account context by passing the `x-hedera-account-id` header in the HTTP request. This identifies which account the transactions are being built for.

> [!NOTE]
> When [wallet signing](#wallet-signing-non-custodial) is enabled, the account comes from the
> verified access token instead and the `x-hedera-account-id` header is **ignored** — a client
> must not be able to name an account it has not proven it controls.

## Wallet Signing (non-custodial)

An **optional** mode in which the user approves and signs every transaction in their own
wallet over WalletConnect v2 / [HIP-820](https://hips.hedera.com/hip/hip-820). The server
holds no Hedera keys of any kind, never submits a transaction, and never sees a user
signature — the wallet signs *and* broadcasts.

It is off unless both `WALLETCONNECT_PROJECT_ID` and `PUBLIC_URL` are set. Without them the
server behaves exactly as documented above.

**In wallet mode, each write tool auto-delivers.** The tool definitions are untouched, but a
wrapper runs the underlying Hedera tool to build the transaction and then **delivers it to
the wallet for approval, returning a `requestId`** — one call, no bytes handled by the model.
(In dev mode, with no wallet bound, the tools return unsigned bytes exactly as before.)

### How it works

```
1. transfer_hbar_tool({ to, amount })  ->  { requestId, summary, walletVerifiable, ... }
                                            (built AND delivered to the wallet in one call;
                                            also walletKind, approveUrl?, hint)
2. check_signing_status({ requestId }) ->  awaiting_approval | confirming | executed
                                            | rejected | failed | expired | needs_reauth
```

The write tool never blocks: it returns a `requestId` at once and the wallet prompt resolves
in the background (MCP clients cap tool calls near 60s, well under human approval time).
After the wallet broadcasts, the server confirms the transaction on the mirror node before
reporting `executed` — so a stale-window approval that never lands is reported honestly, not
as success.

### Added tools

| Tool | Args | Returns |
| --- | --- | --- |
| `wallet_status` | none | `accountId`, `network`, `sessionExpiry` (the WC session expiry), `walletKind`, `walletName?` |
| `check_signing_status` | `requestId`, `waitMs?` (long-poll, default 45s, max 55s; `0` = non-blocking) | `status`, `transactionId?`, `hashscanUrl?`, `nextStep` |
| `sign_with_wallet` | `bytes` | `requestId`, … — raw-bytes escape hatch; normally unnecessary since write tools auto-deliver |

Status values: `awaiting_approval` → `confirming` (mirror-node check) → `executed`, or
`rejected` / `failed` (reached the network but failed on-chain) / `expired` / `needs_reauth`.

### Sign-in

The server is an OAuth 2.1 authorization server whose login form is a wallet. MCP clients
start this flow on their own when `/mcp` returns `401`:

1. Client runs OAuth 2.1 authorization-code + PKCE and opens `/authorize`.
2. That redirects to `/connect`, which offers a **browser-extension** button (for
   detected HIP-820 wallet extensions) and a **WalletConnect QR code** for mobile wallets.
3. The user pairs their wallet, then approves a **sign-in message** — a single-use nonce
   bound to this server's domain and an issued-at time. Signing it moves no funds.
4. The signature is verified against the account's key from the mirror node. Only then is
   an authorization code issued.
5. The token's subject *is* that proven Hedera account.

There are no pairing tools: an authenticated request always has a wallet behind it. If the
wallet session ends, tools report `needs_reauth` and the client re-runs the flow.

### Security notes

- **The payer is never a parameter.** It comes from the token, and `sign_with_wallet`
  re-checks the decoded transaction's payer against it before anything reaches a wallet.
  Those bytes travel through the model's context, so they are not trusted.
- **`walletVerifiable: false`** marks transaction types a wallet cannot fully decode
  (contract calls, file operations). The agent must relay that warning: for those types the
  wallet's display is not an independent check.
- **Access tokens never outlive their wallet session**, and a wallet-side disconnect purges
  the pairing and its grants immediately.
- **Run behind a TLS-terminating reverse proxy.** The server speaks plaintext HTTP; bearer
  tokens and the `wc:` pairing URI must never traverse an untrusted network in the clear.
  Binding a non-loopback host with no authentication is refused at startup (`ALLOW_INSECURE=true`
  overrides — never in production). Set `TRUST_PROXY_HOPS` to your proxy depth.
- **Resource governance.** `MAX_SESSIONS`, `RATE_LIMIT_PER_MINUTE`, and
  `MAX_CONCURRENT_APPROVALS` bound session growth, request rate, and per-account wallet prompts.
- **The Postgres store is secret-adjacent.** Grants and auth codes are stored hashed. The
  `wc_kv` table holds WalletConnect session symmetric keys, envelope-encrypted at rest
  (AES-256-GCM) with `WC_ENCRYPTION_KEY` — required in wallet mode; the server refuses to start
  without it unless `WC_ALLOW_PLAINTEXT=true` opts into cleartext storage (non-production only).
  Even in the clear, a leaked database allows *prompt initiation*, never signing. Restrict
  database access; sourcing the key from a KMS is a planned follow-up.
- **Single instance only.** The database layer requires exactly one server process (see
  `docs/DATABASE.md`); a second one against the same Postgres refuses to boot via an advisory
  lock. Do not autoscale horizontally, deploy stop-then-start (K8s `strategy: Recreate`), and
  point `DATABASE_URL` at a direct connection rather than a transaction-pooling proxy.

### Not implemented yet

> [!WARNING]
> This mode has been exercised end-to-end on **testnet** (sign-in, delivery, mirror-confirm).
> WalletConnect sessions persist across a server restart (Postgres-backed store), and the
> concurrent-approval cap and at-rest encryption are in place. Not built: **spend policies, an
> append-only audit log, and HA failover** (the server runs as a single instance). See
> [`docs/SPEC.md`](docs/SPEC.md) §11 for the known limitations.

Status of the hardening items:

| Area | Status |
| --- | --- |
| Prompt-spam quotas | Implemented — concurrent-approval cap (`MAX_CONCURRENT_APPROVALS`) + request rate limit (`RATE_LIMIT_PER_MINUTE`); per-account cooldown not yet |
| Spend policies (per-tx / per-day caps, recipient allowlists) | Not implemented |
| Append-only audit log | Not implemented |
| HA / active-standby failover | Not implemented — single stateful instance |
| Server-side re-issue on the ~180s validity window | Not implemented — an expired request reports `expired` and the agent re-runs the write tool |
| Threshold / key-list accounts at sign-in | Not supported — single-key accounts only |
| Mainnet | Untested — testnet only |
| At-rest encryption of session keys | Implemented — AES-256-GCM envelope via `WC_ENCRYPTION_KEY`; sourcing the key from a KMS is the remaining follow-up |

### Database migrations

The OAuth/session schema is owned by **TypeORM migrations**, not auto-sync (`DB_SYNCHRONIZE`
defaults **off** — a forgotten flag in production can't silently drop columns).

```bash
docker compose up -d                       # local Postgres
npm run migration:run                       # apply pending migrations (builds first)
npm run migration:generate --name=AddThing  # after an entity change, generate the diff
npm run migration:revert                    # roll back the last migration
```

Deploy: run `npm run migration:run` as a discrete step (a k8s Job / initContainer), or set
`DB_MIGRATIONS_RUN=true` to apply pending migrations at startup on a single instance. Set
`DB_SYNCHRONIZE=true` only for throwaway local dev. Tests use in-memory sqlite and don't need
migrations.

## Development

```bash
npm test            # vitest (unit + integration; in-memory sqlite, no Postgres needed)
npm run typecheck   # tsc over src and test
npm run lint        # eslint
```

The tests cover the logic that does not need a live wallet: nonce lifecycle, payer verification,
the signing status machine, the session store, and the HTTP surface. The WalletConnect pairing
handshake and the `hedera_signAndExecuteTransaction` round trip need a real wallet and are tested
manually on testnet.

Further reading:

- [`docs/SPEC.md`](docs/SPEC.md) — architecture, trust model, tool surface and known limitations
- [`docs/DATABASE.md`](docs/DATABASE.md) — the Postgres schema and the single-instance requirement
- [`SECURITY.md`](SECURITY.md) — reporting vulnerabilities and deployment requirements

## Contributing

Issues and pull requests are welcome. Before opening a PR, please make sure `npm test`,
`npm run typecheck` and `npm run lint` pass, and keep changes focused. Report security issues
privately as described in [`SECURITY.md`](SECURITY.md), not in public issues.

## License

Copyright 2026 Hedera Hashgraph, LLC. Licensed under the [Apache License 2.0](LICENSE); see
[`NOTICE`](NOTICE) for attributions.

The sign-in page bundles the Montserrat typeface under the
[SIL Open Font License 1.1](assets/fonts/OFL.txt). The Hedera name and logo shown on the sign-in
page are trademarks of Hedera Hashgraph, LLC; they are not covered by the Apache license.

Installing this server also installs WalletConnect and Reown packages, which are source-available
rather than open source and are not covered by the Apache license. They are licensed under the
[WalletConnect Community License](licenses/WALLETCONNECT-COMMUNITY-LICENSE.md) and the
[Reown Community License](licenses/REOWN-COMMUNITY-LICENSE.md), and those terms apply to anyone
who installs or runs the server. Portions © 2025 Reown, Inc. All Rights Reserved.

If you run it as a service, read those licences first. Among other things they require a
commercial licence from Reown above their usage thresholds (§3), require connecting through the
Reown relay network (§2b), and require the Reown copyright notice above in the service's notices or
the about section of its website (§2a).

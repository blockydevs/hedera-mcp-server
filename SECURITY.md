# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in this server, please report it privately —
**do not open a public issue**.

- Email the maintainers at **security@blockydevs.com** (or open a private security advisory on
  the GitHub repository).
- Include a description, reproduction steps, affected version/commit, and any PoC.
- We aim to acknowledge within 3 business days and to provide a remediation timeline after triage.

Please give us reasonable time to investigate and release a fix before any public disclosure.

## Scope & threat model

This is a **non-custodial** MCP server: in `RETURN_BYTES` mode it holds no operator key, and
transactions are signed by the user's own wallet over WalletConnect. The wallet approval is the
final authorization boundary, so the server cannot move funds on its own.

Highest-value reports concern: authentication/authorization bypass, cross-tenant session or
context access, denial of service, the WalletConnect signing path, and the OAuth 2.1 flow.

## Deployment requirements

- **Run behind a TLS-terminating reverse proxy.** The server speaks plaintext HTTP; bearer
  tokens and `wc:` pairing URIs must never traverse an untrusted network in the clear.
- **Do not expose the port directly.** Binding a non-loopback host without authentication is
  refused at startup (override only with `ALLOW_INSECURE=true`, never in production).
- **Enable authentication.** Wallet signing (`WALLETCONNECT_PROJECT_ID` + `PUBLIC_URL`) provides
  per-caller identity; without it the server is an unauthenticated dev endpoint.
- **Restrict database access.** The session store holds SHA-256-hashed tokens and auth codes, and
  the WalletConnect relay session keys. `WC_ENCRYPTION_KEY` (min 32 chars) envelope-encrypts those
  relay keys at rest (AES-256-GCM) and is **required in wallet mode** — the server refuses to
  start without it unless `WC_ALLOW_PLAINTEXT=true` explicitly opts into plaintext storage
  (non-production only; surfaced as `wcKv: "plaintext"` on `/readyz` for monitoring). Also use a
  private network and database-level encryption at rest.
- **Run exactly one instance.** Single-instance is a hard requirement of the persistence layer
  (`docs/DATABASE.md`) and is enforced at boot with a Postgres advisory lock — a second process
  against the same database refuses to start. This requires deploying stop-then-start (K8s
  `strategy: Recreate`) and a direct `DATABASE_URL`, not a transaction-pooling proxy; see
  `docs/DATABASE.md` §10.
- **Keep the probe endpoints internal.** `/healthz` and `/readyz` are unauthenticated by design
  (they precede auth and rate limiting) and `/readyz` reports whether `wc_kv` encryption is
  active. Expose them to your orchestrator/load balancer, not the public internet.

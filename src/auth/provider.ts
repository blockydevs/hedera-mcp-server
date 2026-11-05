import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { LedgerId, PublicKey } from '@hiero-ledger/sdk';
import { getMirrornodeService } from '@hashgraph/hedera-agent-kit';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { SessionStore, newToken, type Grant } from '../store/session-store.js';
import { NonceRegistry, buildSignInMessage } from './nonce.js';
import { WalletApprover } from '../wallet/approver.js';
import { loadWalletConnect } from '../wallet/wc.js';
import { walletConfig, caipChainId, networkName } from '../config.js';

/**
 * OAuth 2.1 authorization server whose login form is a wallet.
 *
 * The MCP SDK's `mcpAuthRouter` supplies the protocol machinery — /authorize, /token,
 * /register, /revoke, metadata, PKCE — and this provider supplies the only interesting
 * part: the authorize step hands the browser to a WalletConnect ceremony, and an
 * authorization code is minted only after a nonce signature verifies against the account's
 * key on the mirror node. The token's subject therefore IS a proven Hedera account; it is
 * never taken from client input.
 *
 * Token and pairing are 1:1, so revoking a token kills exactly one device's session.
 */

export const WALLET_SCOPE = 'hedera:sign';

/**
 * The typed shape this provider writes into the access token's `extra` (SDK `AuthInfo.extra` is
 * an untyped `Record<string, unknown>`). Consumers read it through {@link walletAuthExtra} so
 * the producer and every reader share one type — a typo can't silently become `undefined`.
 */
export interface WalletAuthExtra {
  accountId: string;
  pairingRef: string;
  topic: string;
  network: string;
  sessionExpiry?: number;
}

/** Reads the wallet auth context off a request, or undefined in dev mode (no token). */
export function walletAuthExtra(auth: AuthInfo | undefined): WalletAuthExtra | undefined {
  const extra = auth?.extra as Partial<WalletAuthExtra> | undefined;
  if (!extra?.accountId || !extra.topic || !extra.network || !extra.pairingRef) return undefined;
  return {
    accountId: extra.accountId,
    pairingRef: extra.pairingRef,
    topic: extra.topic,
    network: extra.network,
    sessionExpiry: extra.sessionExpiry,
  };
}

export interface Ceremony {
  ceremonyId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  status: 'pending' | 'pairing' | 'awaiting_signature' | 'complete' | 'failed';
  uri?: string;
  accountId?: string;
  topic?: string;
  redirectTo?: string;
  error?: string;
  expiresAt: number;
}

class WalletClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly store: SessionStore) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.store.getClient<OAuthClientInformationFull>(clientId);
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): Promise<OAuthClientInformationFull> {
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    await this.store.putClient(registered.client_id, registered);
    return registered;
  }
}

export class WalletOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly ceremonies = new Map<string, Ceremony>();
  private readonly nonces: NonceRegistry;

  constructor(
    private readonly store: SessionStore,
    private readonly approver: WalletApprover,
    private readonly ledgerId: LedgerId,
  ) {
    this.clientsStore = new WalletClientsStore(store);
    this.nonces = new NonceRegistry(walletConfig.nonceTtlMs);
  }

  // --- authorize: hand the browser to the wallet ceremony --------------------

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const ceremony: Ceremony = {
      ceremonyId: randomUUID(),
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      status: 'pending',
      expiresAt: Date.now() + walletConfig.ceremonyTtlMs,
    };
    this.ceremonies.set(ceremony.ceremonyId, ceremony);
    res.redirect(`/connect?ceremony=${encodeURIComponent(ceremony.ceremonyId)}`);
  }

  getCeremony(ceremonyId: string): Ceremony | undefined {
    const ceremony = this.ceremonies.get(ceremonyId);
    if (!ceremony) return undefined;
    if (ceremony.expiresAt <= Date.now() && ceremony.status !== 'complete') {
      ceremony.status = 'failed';
      ceremony.error = 'Sign-in ceremony expired';
    }
    return ceremony;
  }

  /**
   * Drives one ceremony: pair, challenge, verify, mint code.
   *
   * The nonce signature is what turns "a wallet claimed this account" into "this account's
   * key signed for it". Without it a wallet could assert any account id and have quota and
   * audit attributed to it — it could never spend from it, but it could impersonate it here.
   */
  async runCeremony(ceremonyId: string): Promise<Ceremony> {
    const ceremony = this.getCeremony(ceremonyId);
    if (!ceremony) throw new Error('Unknown sign-in ceremony');
    if (ceremony.status !== 'pending') return ceremony;

    ceremony.status = 'pairing';
    const { uri, approval } = await this.approver.startPairing();
    ceremony.uri = uri;

    void (async () => {
      try {
        const session = await approval;
        const caipAccount = session.namespaces.hedera?.accounts?.[0];
        if (!caipAccount) throw new Error('Wallet approved a session with no Hedera account');

        const accountId = caipAccount.split(':').pop();
        if (!accountId) throw new Error('Could not read account id from the wallet session');

        ceremony.topic = session.topic;
        ceremony.accountId = accountId;
        ceremony.status = 'awaiting_signature';

        const nonce = this.nonces.issue(new URL(walletConfig.publicUrl).host);
        const message = buildSignInMessage({
          domain: nonce.domain,
          accountId,
          uri: walletConfig.publicUrl,
          chainId: caipChainId(this.ledgerId),
          nonce: nonce.nonce,
          issuedAt: nonce.issuedAt,
        });

        const signatureMap = await this.approver.signMessage(session.topic, accountId, message);

        if (!this.nonces.consume(nonce.nonce)) {
          throw new Error('Sign-in challenge expired or was already used');
        }
        await this.verifySignature(accountId, message, signatureMap);

        // If the ceremony was pruned (its TTL lapsed) while we awaited the wallet, completing
        // now would store a pairing + code the browser can no longer collect and leave the WC
        // session dangling. Tear it down instead of orphaning it.
        if (!this.ceremonies.has(ceremony.ceremonyId)) {
          await this.approver.disconnect(session.topic);
          return;
        }

        const pairingRef = randomUUID();
        await this.store.putPairing({
          pairingRef,
          topic: session.topic,
          accountId,
          network: networkName(this.ledgerId),
          createdAt: Date.now(),
          // A token must never outlive the pairing it rides on.
          expiresAt: session.expiry ? session.expiry * 1000 : Date.now() + walletConfig.refreshTokenTtlMs,
        });

        const code = newToken();
        await this.store.putAuthCode(code, {
          clientId: ceremony.clientId,
          redirectUri: ceremony.redirectUri,
          codeChallenge: ceremony.codeChallenge,
          pairingRef,
          accountId,
          expiresAt: Date.now() + 5 * 60 * 1000,
        });

        const redirect = new URL(ceremony.redirectUri);
        redirect.searchParams.set('code', code);
        if (ceremony.state) redirect.searchParams.set('state', ceremony.state);
        ceremony.redirectTo = redirect.toString();
        ceremony.status = 'complete';
      } catch (error) {
        ceremony.status = 'failed';
        ceremony.error = error instanceof Error ? error.message : String(error);
        // The pairing was established but never bound to a token (abandoned or the
        // signature failed to verify). Tear it down rather than leave a live wallet
        // channel dangling. Safe because a failed ceremony never reaches `complete`.
        if (ceremony.topic) void this.approver.disconnect(ceremony.topic);
      }
    })();

    return ceremony;
  }

  /**
   * Verifies the challenge signature against the account's key as published by the mirror
   * node. Known limitation (docs/SPEC.md §11): this covers single-key accounts only. A
   * threshold/keylist account has no single public key to check here, so sign-in is
   * refused rather than waved through.
   */
  private async verifySignature(
    accountId: string,
    message: string,
    signatureMap: string,
  ): Promise<void> {
    const mirrornode = getMirrornodeService(undefined, this.ledgerId);
    const account = await mirrornode.getAccount(accountId);
    const publicKeyString = account?.accountPublicKey;

    if (!publicKeyString) {
      throw new Error(
        `No single public key published for ${accountId}. Threshold and key-list accounts are not supported for sign-in yet.`,
      );
    }

    const publicKey = PublicKey.fromString(publicKeyString);
    if (!loadWalletConnect().verifyMessageSignature(message, signatureMap, publicKey)) {
      throw new Error('Sign-in signature did not verify against the account key');
    }
  }

  // --- token exchange -------------------------------------------------------

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = await this.store.peekAuthCode(authorizationCode);
    if (!record) throw new Error('Invalid or expired authorization code');
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const record = await this.store.consumeAuthCode(authorizationCode);
    if (!record) throw new Error('Invalid or expired authorization code');
    if (record.clientId !== client.client_id) throw new Error('Authorization code was issued to a different client');
    // RFC 6749 §4.1.3: the redirect_uri at the token endpoint must match the one from the
    // authorization request. (PKCE is verified by the SDK; this closes the remaining binding.)
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new Error('redirect_uri does not match the authorization request');
    }
    return this.issueTokens(client.client_id, record.pairingRef, record.accountId);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const grant = await this.store.getGrant(refreshToken);
    if (!grant?.isRefresh) throw new Error('Invalid refresh token');
    if (grant.clientId !== client.client_id) throw new Error('Refresh token was issued to a different client');

    // Refresh only works while the wallet session behind it is alive; once the pairing is
    // gone the client must re-run the full ceremony.
    const pairing = await this.store.getPairing(grant.pairingRef);
    if (!pairing || !this.approver.hasSession(pairing.topic)) {
      await this.store.deleteGrant(refreshToken);
      throw new Error('Wallet session has ended — re-authorization required');
    }

    await this.store.deleteGrant(refreshToken);
    return this.issueTokens(client.client_id, grant.pairingRef, grant.accountId);
  }

  private async issueTokens(
    clientId: string,
    pairingRef: string,
    accountId: string,
  ): Promise<OAuthTokens> {
    const pairing = await this.store.getPairing(pairingRef);
    if (!pairing) throw new Error('Wallet session has ended — re-authorization required');

    const accessToken = newToken();
    const refreshToken = newToken();
    // Cap both at the pairing's own expiry: a token must never outlive its wallet session.
    const accessExpiry = Math.min(Date.now() + walletConfig.accessTokenTtlMs, pairing.expiresAt);
    const refreshExpiry = Math.min(Date.now() + walletConfig.refreshTokenTtlMs, pairing.expiresAt);

    const base: Omit<Grant, 'expiresAt' | 'isRefresh'> = {
      clientId,
      pairingRef,
      accountId,
      scopes: [WALLET_SCOPE],
    };
    await this.store.putGrant(accessToken, { ...base, expiresAt: accessExpiry });
    await this.store.putGrant(refreshToken, { ...base, expiresAt: refreshExpiry, isRefresh: true });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.max(1, Math.floor((accessExpiry - Date.now()) / 1000)),
      refresh_token: refreshToken,
      scope: WALLET_SCOPE,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const grant = await this.store.getGrant(token);
    if (!grant || grant.isRefresh) throw new Error('Invalid or expired access token');

    const pairing = await this.store.getPairing(grant.pairingRef);
    if (!pairing) throw new Error('Wallet session has ended — re-authorization required');

    const extra: WalletAuthExtra = {
      accountId: grant.accountId,
      pairingRef: grant.pairingRef,
      topic: pairing.topic,
      network: pairing.network,
      // The WalletConnect session expiry (7 d), so wallet_status can report the real session
      // lifetime rather than the shorter access-token expiry.
      sessionExpiry: pairing.expiresAt,
    };
    return {
      token,
      clientId: grant.clientId,
      scopes: grant.scopes,
      expiresAt: Math.floor(grant.expiresAt / 1000),
      // AuthInfo.extra is an untyped Record; cast once at this single write boundary. Readers
      // go through walletAuthExtra(), which restores the typing.
      extra: extra as unknown as Record<string, unknown>,
    };
  }

  /** Drops expired sign-in ceremonies and nonces, so abandoned flows cannot grow memory. */
  prune(now: number = Date.now()): void {
    for (const [id, ceremony] of this.ceremonies) {
      if (ceremony.expiresAt <= now) {
        // If it paired but never completed sign-in, disconnect the dangling session. A
        // `complete` ceremony's session is bound to a live token — never touch it here.
        if (ceremony.topic && ceremony.status !== 'complete') {
          void this.approver.disconnect(ceremony.topic);
        }
        this.ceremonies.delete(id);
      }
    }
    this.nonces.prune(now);
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const grant = await this.store.getGrant(request.token);
    await this.store.deleteGrant(request.token);
    // Revoking a token disconnects its wallet pairing too — they are 1:1.
    if (grant) {
      const pairing = await this.store.getPairing(grant.pairingRef);
      if (pairing) {
        await this.approver.disconnect(pairing.topic);
        await this.store.deletePairing(grant.pairingRef);
      }
    }
  }
}

import { LedgerId } from '@hiero-ledger/sdk';
import type { DataSource } from 'typeorm';
import type { DAppConnector, DAppSigner } from '@hashgraph/hedera-wallet-connect';
import type { SessionTypes } from '@walletconnect/types';
import { walletConfig, caipChainId } from '../config.js';
import { deriveEncryptionKey } from '../crypto/envelope.js';
import { loadWalletConnect } from './wc.js';
import { PgKvStorage } from './pg-kv-storage.js';
import { initDAppConnectorWithStorage } from './dapp-connector-init.js';
import { walletPresenceOf, type WalletPresence } from './wallet-presence.js';
import { logger } from '../logger.js';

/**
 * The WalletConnect dApp client — the service's only channel to a user's wallet.
 *
 * Two deliberate departures from the convenience API:
 *
 * 1. Requests are routed by SESSION TOPIC, never by account. `DAppConnector.request()`
 *    resolves a signer with `signers.find(s => s.getAccountId() === accountId)`, so when
 *    one account is paired twice — which is expected, e.g. a user on two
 *    machines — a sign request can be delivered to the wrong device's wallet. A topic is
 *    unique per pairing, so routing by topic delivers to the session that asked.
 *
 * 2. Transactions cross this boundary as base64, never as SDK objects. HIP-820's
 *    `hedera_signAndExecuteTransaction` is base64-native and the agent kit already hands
 *    us bytes, so nothing here depends on both packages agreeing on an SDK version.
 *
 * The service holds no Hedera key and never submits anything: the wallet signs AND
 * broadcasts.
 */

export type SessionGoneListener = (topic: string) => void;

export class SessionGoneError extends Error {
  constructor(message = 'WalletConnect session is no longer available') {
    super(message);
    this.name = 'SessionGoneError';
  }
}

export class WalletApprover {
  private connector?: DAppConnector;
  private methods?: Record<string, string>;
  private readonly sessionGoneListeners: SessionGoneListener[] = [];
  /** Session-gone topics that arrived before any listener was attached; replayed on subscribe. */
  private readonly pendingSessionGone: string[] = [];

  constructor(
    private readonly ledgerId: LedgerId,
    private readonly dataSource: DataSource,
  ) {}

  async init(): Promise<void> {
    if (this.connector) return;

    const wc = loadWalletConnect();
    this.methods = wc.HederaJsonRpcMethod;

    const connector = new wc.DAppConnector(
      walletConfig.metadata,
      this.ledgerId,
      walletConfig.projectId,
      Object.values(wc.HederaJsonRpcMethod),
      [wc.HederaSessionEvent.ChainChanged, wc.HederaSessionEvent.AccountsChanged],
      [this.ledgerId === LedgerId.MAINNET ? wc.HederaChainId.Mainnet : wc.HederaChainId.Testnet],
    );

    // Instead of connector.init() (which uses WalletConnect's default file storage), inject a
    // Postgres-backed store so relay sessions persist to the same DB as our grants and survive
    // a restart. See dapp-connector-init.ts for why this replicates init() by hand.
    await initDAppConnectorWithStorage(
      connector,
      walletConfig.projectId,
      walletConfig.metadata,
      new PgKvStorage(this.dataSource, deriveEncryptionKey(walletConfig.wcEncryptionKey)),
    );
    this.connector = connector;

    // initDAppConnectorWithStorage always sets walletConnectClient or throws, so it is present
    // here. Events can fire before onSessionGone() is called (e.g. a session_delete the relay
    // replays on reconnect), so emit() buffers when there are no listeners yet.
    const wcClient = connector.walletConnectClient!;
    wcClient.on('session_delete', ({ topic }: { topic: string }) => this.emitSessionGone(topic));
    wcClient.on('session_expire', ({ topic }: { topic: string }) => this.emitSessionGone(topic));
  }

  private emitSessionGone(topic: string): void {
    if (this.sessionGoneListeners.length === 0) {
      this.pendingSessionGone.push(topic);
      return;
    }
    this.sessionGoneListeners.forEach(listener => listener(topic));
  }

  /** Notified when a wallet disconnects or a session expires, so grants can be purged. */
  onSessionGone(listener: SessionGoneListener): void {
    this.sessionGoneListeners.push(listener);
    // Replay any events that arrived before a listener existed, so no purge is missed.
    const pending = this.pendingSessionGone.splice(0);
    pending.forEach(topic => listener(topic));
  }

  private require(): DAppConnector {
    if (!this.connector) throw new Error('WalletApprover not initialised');
    return this.connector;
  }

  /**
   * Begins a pairing. Resolves as soon as the `wc:` URI exists (so the browser can render
   * a QR immediately); `approval` settles later, when the user accepts in their wallet.
   */
  async startPairing(): Promise<{ uri: string; approval: Promise<SessionTypes.Struct> }> {
    const connector = this.require();
    return new Promise((resolve, reject) => {
      const approval = connector.connect(uri => resolve({ uri, approval }));
      approval.catch(reject);
    });
  }

  /** The signer for exactly this pairing. Absent once the wallet has disconnected. */
  private signerForTopic(topic: string): DAppSigner {
    const signer = this.require().signers.find(candidate => candidate.topic === topic);
    if (!signer) {
      logger.warn('no signer for topic', { topic, available: this.require().signers.map(s => s.topic) });
      throw new SessionGoneError();
    }
    return signer;
  }

  /** Read from the peer metadata WalletConnect persists with the session (no column of our own). */
  walletPresence(topic: string): WalletPresence {
    const session = this.connector?.walletConnectClient?.session
      .getAll()
      .find((candidate: SessionTypes.Struct) => candidate.topic === topic);
    return walletPresenceOf(session?.peer.metadata);
  }

  hasSession(topic: string): boolean {
    return this.connector?.signers.some(signer => signer.topic === topic) ?? false;
  }

  private method(name: 'SignMessage' | 'SignAndExecuteTransaction'): string {
    const method = this.methods?.[name];
    if (!method) throw new Error('WalletApprover not initialised');
    return method;
  }

  /** Asks the wallet to sign the sign-in challenge. Returns a base64 proto.SignatureMap. */
  async signMessage(topic: string, accountId: string, message: string): Promise<string> {
    const signer = this.signerForTopic(topic);
    const result = await signer.request<{ signatureMap: string }>({
      method: this.method('SignMessage'),
      params: { signerAccountId: `${caipChainId(this.ledgerId)}:${accountId}`, message },
    });
    return result.signatureMap;
  }

  /**
   * Delivers a frozen transaction for approval. The promise settles only when the user
   * approves (wallet signs and broadcasts) or rejects — callers must not await it inside
   * an MCP tool handler.
   */
  async signAndExecute(
    topic: string,
    accountId: string,
    transactionBase64: string,
  ): Promise<{ transactionId: string }> {
    const signer = this.signerForTopic(topic);
    const signerAccountId = `${caipChainId(this.ledgerId)}:${accountId}`;
    logger.debug('delivering signAndExecuteTransaction', { accountId, txLen: transactionBase64.length });
    try {
      const result = await signer.request<{ transactionId?: string; nodeId?: string }>({
        method: this.method('SignAndExecuteTransaction'),
        params: { signerAccountId, transactionList: transactionBase64 },
      });
      logger.debug('wallet responded', { transactionId: result?.transactionId });
      if (!result?.transactionId) {
        throw new Error('Wallet returned no transactionId');
      }
      return { transactionId: result.transactionId };
    } catch (error) {
      logger.warn('signAndExecute failed', { accountId, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async disconnect(topic: string): Promise<void> {
    try {
      await this.require().disconnect(topic);
    } catch {
      // Session already gone — nothing to tear down.
    }
  }
}

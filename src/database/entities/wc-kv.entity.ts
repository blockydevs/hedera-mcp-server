import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * WalletConnect's own key-value store, backed by Postgres so relay sessions (and their
 * signers) survive a server restart — coherently with the OAuth grants that also persist.
 *
 * Populated by {@link PgKvStorage}, WalletConnect's `IKeyValueStorage` adapter. Values are
 * arbitrary JSON (sessions, keychain, subscriptions); `simple-json` serialises them
 * portably across Postgres and sqlite.
 */
@Entity('wc_kv')
export class WcKvEntity {
  @PrimaryColumn({ type: 'varchar' })
  key!: string;

  @Column({ type: 'simple-json', nullable: true })
  value!: unknown;
}

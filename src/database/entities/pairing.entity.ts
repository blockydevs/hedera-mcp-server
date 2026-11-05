import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { msTimestamp } from '../columns.js';

/** A WalletConnect pairing bound 1:1 to a token: the routing topic + the proven account. */
@Entity('pairings')
export class PairingEntity {
  @PrimaryColumn({ type: 'varchar' })
  pairingRef!: string;

  @Index()
  @Column({ type: 'varchar' })
  topic!: string;

  @Column({ type: 'varchar' })
  accountId!: string;

  @Column({ type: 'varchar' })
  network!: string;

  @Column({ type: 'bigint', transformer: msTimestamp })
  createdAt!: number;

  @Index()
  @Column({ type: 'bigint', transformer: msTimestamp })
  expiresAt!: number;
}

import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { msTimestamp } from '../columns.js';

/**
 * An issued OAuth grant — access or refresh token. The token itself is never stored; the
 * primary key is its SHA-256 hash, so a leaked database cannot be replayed as a bearer token.
 */
@Entity('grants')
export class GrantEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  tokenHash!: string;

  @Column({ type: 'varchar' })
  clientId!: string;

  @Index()
  @Column({ type: 'varchar' })
  pairingRef!: string;

  @Column({ type: 'varchar' })
  accountId!: string;

  @Column({ type: 'simple-array' })
  scopes!: string[];

  @Column({ type: 'boolean', default: false })
  isRefresh!: boolean;

  @Index()
  @Column({ type: 'bigint', transformer: msTimestamp })
  expiresAt!: number;
}

import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { msTimestamp } from '../columns.js';

/** A single-use OAuth authorization code, keyed by its SHA-256 hash. */
@Entity('auth_codes')
export class AuthCodeEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  codeHash!: string;

  @Column({ type: 'varchar' })
  clientId!: string;

  @Column({ type: 'varchar' })
  redirectUri!: string;

  @Column({ type: 'varchar' })
  codeChallenge!: string;

  @Column({ type: 'varchar' })
  pairingRef!: string;

  @Column({ type: 'varchar' })
  accountId!: string;

  @Index()
  @Column({ type: 'bigint', transformer: msTimestamp })
  expiresAt!: number;
}

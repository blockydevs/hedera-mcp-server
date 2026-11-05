import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { msTimestamp } from '../columns.js';

/**
 * A dynamically-registered OAuth client. The full client record lives in `data`; `issuedAt`
 * (ms) is a separate indexed column so aged clients can be swept by the prune query — Dynamic
 * Client Registration is unauthenticated, so clients must not accumulate unbounded.
 */
@Entity('oauth_clients')
export class OAuthClientEntity {
  @PrimaryColumn({ type: 'varchar' })
  clientId!: string;

  @Column({ type: 'simple-json' })
  data!: Record<string, unknown>;

  @Index()
  @Column({ type: 'bigint', transformer: msTimestamp })
  issuedAt!: number;
}

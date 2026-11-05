import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1785146320131 implements MigrationInterface {
    name = 'InitialSchema1785146320131'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "grants" ("tokenHash" character varying(64) NOT NULL, "clientId" character varying NOT NULL, "pairingRef" character varying NOT NULL, "accountId" character varying NOT NULL, "scopes" text NOT NULL, "isRefresh" boolean NOT NULL DEFAULT false, "expiresAt" bigint NOT NULL, CONSTRAINT "PK_98476760cd78deb95228e054258" PRIMARY KEY ("tokenHash"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2e1294814e7b7e10d8b2ea728c" ON "grants" ("pairingRef") `);
        await queryRunner.query(`CREATE INDEX "IDX_cecf4b5d177bacd013faa30a3d" ON "grants" ("expiresAt") `);
        await queryRunner.query(`CREATE TABLE "pairings" ("pairingRef" character varying NOT NULL, "topic" character varying NOT NULL, "accountId" character varying NOT NULL, "network" character varying NOT NULL, "createdAt" bigint NOT NULL, "expiresAt" bigint NOT NULL, CONSTRAINT "PK_ca89a426eebabb9f2bd90cf451b" PRIMARY KEY ("pairingRef"))`);
        await queryRunner.query(`CREATE INDEX "IDX_98ebc3eb1e80405afccbe83dc9" ON "pairings" ("topic") `);
        await queryRunner.query(`CREATE INDEX "IDX_2e6fb7bfcc2b82988eac07cab6" ON "pairings" ("expiresAt") `);
        await queryRunner.query(`CREATE TABLE "auth_codes" ("codeHash" character varying(64) NOT NULL, "clientId" character varying NOT NULL, "redirectUri" character varying NOT NULL, "codeChallenge" character varying NOT NULL, "pairingRef" character varying NOT NULL, "accountId" character varying NOT NULL, "expiresAt" bigint NOT NULL, CONSTRAINT "PK_591320c6f7918c2fbaa7d4c5a2d" PRIMARY KEY ("codeHash"))`);
        await queryRunner.query(`CREATE INDEX "IDX_fce9f5ebaecf1e96ce5044c521" ON "auth_codes" ("expiresAt") `);
        await queryRunner.query(`CREATE TABLE "oauth_clients" ("clientId" character varying NOT NULL, "data" text NOT NULL, "issuedAt" bigint NOT NULL, CONSTRAINT "PK_b0c094fe1ef0a6c4af8f2b10be7" PRIMARY KEY ("clientId"))`);
        await queryRunner.query(`CREATE INDEX "IDX_0ae2e8b662dc1eaae17ab26072" ON "oauth_clients" ("issuedAt") `);
        await queryRunner.query(`CREATE TABLE "wc_kv" ("key" character varying NOT NULL, "value" text, CONSTRAINT "PK_da0834805466eb1becf17b0ce3d" PRIMARY KEY ("key"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "wc_kv"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0ae2e8b662dc1eaae17ab26072"`);
        await queryRunner.query(`DROP TABLE "oauth_clients"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fce9f5ebaecf1e96ce5044c521"`);
        await queryRunner.query(`DROP TABLE "auth_codes"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2e6fb7bfcc2b82988eac07cab6"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_98ebc3eb1e80405afccbe83dc9"`);
        await queryRunner.query(`DROP TABLE "pairings"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cecf4b5d177bacd013faa30a3d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2e1294814e7b7e10d8b2ea728c"`);
        await queryRunner.query(`DROP TABLE "grants"`);
    }

}

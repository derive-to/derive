import { randomUUID as uuid } from "node:crypto"
import { Pool } from "pg"
import { describe, expect, it } from "vitest"
import { PgMetaStore } from "../src/pg"
import { runStoreContract } from "./store-contract"

// The same MetaStore contract on a REAL Postgres — the only place pg.ts (the
// hosted-tier driver, raw SQL mirroring repos.ts) is exercised by this package's
// own suite. Gated on DOCK_TEST_DB=pg + TEST_DATABASE_URL, which `scripts/test-pg.sh`
// and the CI `pg` job set after standing up an ephemeral Postgres. A wrong WHERE, a
// missing org scope, or a broken transaction in pg.ts fails the same assertion that
// passes on SQLite. Without the env it's a no-op (so `pnpm test` stays zero-config).
const PG_URL = process.env.DOCK_TEST_DB === "pg" ? process.env.TEST_DATABASE_URL : undefined

if (PG_URL) {
  const url = PG_URL
  runStoreContract("pg store", async () => {
    // Each run gets its own schema (search_path) so concurrent test files and reruns
    // never collide; PgMetaStore.create applies the DDL into it. Dropped on teardown.
    const schema = `t_db_${process.pid}_${uuid().replace(/-/g, "")}`
    const boot = new Pool({ connectionString: url, max: 1 })
    await boot.query(`CREATE SCHEMA ${schema}`)
    await boot.end()
    const opt = encodeURIComponent(`-c search_path=${schema}`)
    const store = await PgMetaStore.create(`${url}${url.includes("?") ? "&" : "?"}options=${opt}`)
    const cleanup = async () => {
      await store.close()
      const drop = new Pool({ connectionString: url, max: 1 })
      await drop.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await drop.end()
    }
    return { store, cleanup }
  })

  // The oauth-provider methods read Better Auth's tables (created out of band by the
  // auth migrator, not Dock's DDL), so they're seeded + asserted per-dialect here —
  // the pg-store mirror of the sqlite-store OAuth block. Tables are schema-qualified
  // so they land in the same isolated schema the store reads via its search_path.
  describe("pg store: OAuth grants (Better Auth oauth-provider tables)", () => {
    const u = url
    const withStore = async (
      seed: (boot: Pool, schema: string) => Promise<void>,
      run: (store: PgMetaStore) => Promise<void>,
    ) => {
      const schema = `t_oauth_${process.pid}_${uuid().replace(/-/g, "")}`
      const boot = new Pool({ connectionString: u, max: 1 })
      await boot.query(`CREATE SCHEMA ${schema}`)
      await seed(boot, schema)
      await boot.end()
      const opt = encodeURIComponent(`-c search_path=${schema}`)
      const store = await PgMetaStore.create(`${u}${u.includes("?") ? "&" : "?"}options=${opt}`)
      try {
        await run(store)
      } finally {
        await store.close()
        const drop = new Pool({ connectionString: u, max: 1 })
        await drop.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
        await drop.end()
      }
    }

    it("tolerates the oauth tables being absent", async () => {
      await withStore(
        async () => {},
        async (store) => {
          expect(await store.getOAuthGrant("x")).toBeNull()
          expect(await store.getOAuthClientName("x")).toBeNull()
          expect(await store.pruneStaleOAuthClients(new Date().toISOString())).toBe(0)
        },
      )
    })

    it("resolves a seeded grant and reaps only abandoned anonymous clients", async () => {
      await withStore(
        async (boot, schema) => {
          await boot.query(
            `CREATE TABLE ${schema}."user" (id text primary key, email text, name text, image text)`,
          )
          await boot.query(
            `CREATE TABLE ${schema}."oauthClient" ("clientId" text primary key, name text, "userId" text, "createdAt" timestamptz)`,
          )
          await boot.query(
            `CREATE TABLE ${schema}."oauthAccessToken" ("token" text primary key, "clientId" text, "userId" text, "scopes" text, "expiresAt" timestamptz)`,
          )
          await boot.query(
            `CREATE TABLE ${schema}."oauthConsent" (id text primary key, "clientId" text, "userId" text)`,
          )
          await boot.query(
            `INSERT INTO ${schema}."user"(id,email,name) VALUES('u1','amy@x.com','Amy')`,
          )
          await boot.query(
            `INSERT INTO ${schema}."oauthClient"("clientId",name,"userId","createdAt") VALUES('client_live','Claude','u1',now())`,
          )
          await boot.query(
            `INSERT INTO ${schema}."oauthAccessToken"("token","clientId","userId","scopes","expiresAt") VALUES('hash_live','client_live','u1',$1, now() + interval '1 hour')`,
            [JSON.stringify(["dock:read", "dock:publish"])],
          )
          await boot.query(
            `INSERT INTO ${schema}."oauthClient"("clientId",name,"userId","createdAt") VALUES('client_stale','Ghost',NULL,'2020-01-01T00:00:00Z')`,
          )
        },
        async (store) => {
          const grant = await store.getOAuthGrant("hash_live")
          expect(grant).toMatchObject({
            userId: "u1",
            userEmail: "amy@x.com",
            clientName: "Claude",
          })
          expect(grant?.scopes).toEqual(["dock:read", "dock:publish"])
          expect(grant?.expiresAt).toBeInstanceOf(Date)
          expect(await store.getOAuthClientName("client_live")).toBe("Claude")
          expect(await store.getOAuthGrant("missing")).toBeNull()
          // client_live is protected by its access token; only client_stale is reaped.
          expect(await store.pruneStaleOAuthClients("2025-01-01T00:00:00.000Z")).toBe(1)
          expect(await store.getOAuthClientName("client_stale")).toBeNull()
        },
      )
    })
  })
} else {
  // Keep the file non-empty for the default (SQLite-only) run.
  describe("pg store", () => {
    it.skip("skipped — set DOCK_TEST_DB=pg + TEST_DATABASE_URL to run against Postgres", () => {})
  })
}

import { randomUUID as uuid } from "node:crypto"
import { DEFAULT_ORG_SETTINGS } from "@derive/core"
import { Pool } from "pg"
import { describe, expect, it } from "vitest"
import { PgMetaStore } from "../src/pg"
import { runStoreContract } from "./store-contract"

// The same MetaStore contract on a REAL Postgres — the only place pg.ts (the
// hosted-tier driver, raw SQL mirroring repos.ts) is exercised by this package's
// own suite. Gated on DERIVE_TEST_DB=pg + TEST_DATABASE_URL, which `scripts/test-pg.sh`
// and the CI `pg` job set after standing up an ephemeral Postgres. A wrong WHERE, a
// missing org scope, or a broken transaction in pg.ts fails the same assertion that
// passes on SQLite. Without the env it's a no-op (so `pnpm test` stays zero-config).
const PG_URL = process.env.DERIVE_TEST_DB === "pg" ? process.env.TEST_DATABASE_URL : undefined

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
  // auth migrator, not Derive's DDL), so they're seeded + asserted per-dialect here —
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
            // scopes is jsonb to match Better Auth's real table: node-postgres then
            // returns it PARSED (a real array). The old text fixture is exactly why
            // this lane never caught the prod 500 (`s.split is not a function`).
            `CREATE TABLE ${schema}."oauthAccessToken" ("token" text primary key, "clientId" text, "userId" text, "scopes" jsonb, "expiresAt" timestamptz)`,
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
            [JSON.stringify(["derive:read", "derive:publish"])],
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
          expect(grant?.scopes).toEqual(["derive:read", "derive:publish"])
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

  // The user-directory methods read Better Auth's `user` table (created out of
  // band), so — like the OAuth block — they're seeded + asserted per-dialect here.
  describe("pg store: user directory (Better Auth `user` table)", () => {
    const u = url
    const inSchema = async (
      seed: (boot: Pool, schema: string) => Promise<void>,
      run: (store: PgMetaStore) => Promise<void>,
    ) => {
      const schema = `t_pguser_${process.pid}_${uuid().replace(/-/g, "")}`
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

    it("tolerates the user table being absent", async () => {
      await inSchema(
        async () => {},
        async (store) => {
          expect(await store.findUserByEmail("x@y.com")).toBeNull()
          expect(await store.getUsers(["x"])).toEqual([])
          expect(await store.getUserByUsername("ghost")).toBeNull()
          expect(await store.searchDiscoverableUsers("a", 10)).toEqual([])
          expect(await store.listDiscoverableUsers(10)).toEqual([])
          expect(await store.listFollowers("u1", 10)).toEqual([])
          expect(await store.listFollowing("u1", 10)).toEqual([])
          expect(await store.backfillAuthorIds()).toBe(0)
        },
      )
    })

    it("browses discoverable people, resolves follower/following profiles, backfills author_id", async () => {
      await inSchema(
        async (boot, schema) => {
          await boot.query(
            `CREATE TABLE ${schema}."user" (id text primary key, email text, name text, image text, username text, discoverable boolean, profession text, about text)`,
          )
          await boot.query(
            `CREATE TABLE ${schema}."account" (id text primary key, "accountId" text, "providerId" text, "userId" text)`,
          )
          await boot.query(
            `INSERT INTO ${schema}."user"(id,name,username,discoverable,profession) VALUES
               ('u1','Amy','amy',NULL,'Engineering'),('u2','Bo','bo',true,'Design'),
               ('u3','Cy','cy',false,NULL),('u4','Dee',NULL,NULL,NULL)`,
          )
          await boot.query(
            `INSERT INTO ${schema}."account"(id,"accountId","providerId","userId") VALUES ('acc','9999','github','u1')`,
          )
        },
        async (store) => {
          // Browse: discoverable + handle-claimed only, ordered by handle.
          expect((await store.listDiscoverableUsers(10)).map((x) => x.username)).toEqual([
            "amy",
            "bo",
          ])
          // Follower / following lists resolve via the user-table JOIN (the pg-specific
          // raw SQL — a column-case typo here would fail this).
          await store.addFollow({
            id: "f1",
            org_id: "*",
            user_id: "u2",
            kind: "user",
            target: "u1",
          })
          expect((await store.listFollowers("u1", 10)).map((x) => x.username)).toEqual(["bo"])
          expect((await store.listFollowing("u2", 10)).map((x) => x.username)).toEqual(["amy"])
          expect(await store.listFollowers("u2", 10)).toEqual([])
          // Backfill author_id from author_gh_id → Derive user; idempotent.
          const a = await store.createArtifact({
            id: "a1",
            short_id: "sh1",
            org_id: "o",
            slug: null,
            title: "T",
            kind: "file",
            spa: 0,
          })
          await store.addVersion(a.id, {
            id: "v1",
            blob_key: "b",
            content_type: "text/html",
            size_bytes: 1,
            author: "Amy",
            author_gh_id: "9999",
            message: null,
          })
          expect((await store.getArtifactById("a1"))?.author_id).toBeNull()
          expect(await store.backfillAuthorIds()).toBe(1)
          expect((await store.getArtifactById("a1"))?.author_id).toBe("u1")
          expect(await store.backfillAuthorIds()).toBe(0)
        },
      )
    })

    it("resolves users by email/id/handle, sets avatar, powers opt-in search", async () => {
      await inSchema(
        async (boot, schema) => {
          // No column default: unset `discoverable` is NULL, which search treats as
          // discoverable (on by default), same as a pre-migration row.
          await boot.query(
            `CREATE TABLE ${schema}."user" (id text primary key, email text, name text, image text, username text, discoverable boolean, profession text, about text)`,
          )
          await boot.query(`CREATE UNIQUE INDEX ON ${schema}."user" (username)`)
          await boot.query(
            `INSERT INTO ${schema}."user"(id,email,name) VALUES('u1','amy@x.com','Amy'),('u2','bo@x.com','Bo')`,
          )
        },
        async (store) => {
          expect(await store.findUserByEmail("amy@x.com")).toMatchObject({ id: "u1", name: "Amy" })
          expect((await store.getUsers(["u1"])).map((x) => x.email)).toEqual(["amy@x.com"])
          expect(await store.setUsername("u1", "amy")).toBe("ok")
          expect(await store.getUserByUsername("amy")).toMatchObject({ id: "u1", username: "amy" })
          expect(await store.getUserByUsername("nope")).toBeNull()
          expect(await store.setUsername("u2", "amy")).toBe("taken")
          await store.setUserImage("u1", "https://cdn/x.png")
          expect((await store.getUserByUsername("amy"))?.image).toBe("https://cdn/x.png")
          // On by default: amy (NULL discoverable) is found; opting out hides her;
          // opting back in shows her again. Empty query returns nothing.
          expect((await store.searchDiscoverableUsers("am", 10)).map((x) => x.username)).toEqual([
            "amy",
          ])
          expect((await store.searchDiscoverableUsers("AMY", 10)).map((x) => x.id)).toEqual(["u1"])
          await store.setUserDiscoverable("u1", false)
          expect(await store.searchDiscoverableUsers("am", 10)).toEqual([])
          await store.setUserDiscoverable("u1", true)
          expect((await store.searchDiscoverableUsers("am", 10)).map((x) => x.username)).toEqual([
            "amy",
          ])
          expect(await store.searchDiscoverableUsers("", 10)).toEqual([])
        },
      )
    })

    it("round-trips a user brandprint (set, read, clear)", async () => {
      await inSchema(
        async (boot, schema) => {
          await boot.query(
            `CREATE TABLE ${schema}."user" (id text primary key, email text, name text, image text, username text, discoverable boolean, profession text, about text, brandprint text)`,
          )
          await boot.query(
            `INSERT INTO ${schema}."user"(id,email,name) VALUES('u1','amy@x.com','Amy')`,
          )
        },
        async (store) => {
          await store.setUserProfile("u1", {
            brandprint: JSON.stringify({ collectionId: "col_x" }),
          })
          expect(await store.getUserBrandprint("u1")).toBe(
            JSON.stringify({ collectionId: "col_x" }),
          )
          await store.setUserProfile("u1", { brandprint: null })
          expect(await store.getUserBrandprint("u1")).toBeNull()
        },
      )
    })

    it("orgContext matches the two calls it replaces", async () => {
      await inSchema(
        async (boot, schema) => {
          await boot.query(
            `CREATE TABLE ${schema}."user" (id text primary key, email text, name text, brandprint text)`,
          )
          await boot.query(
            `INSERT INTO ${schema}."user"(id,email,name,brandprint) VALUES('u1','amy@x.com','Amy',$1)`,
            [JSON.stringify({ collectionId: "col_x" })],
          )
        },
        async (store) => {
          const org = `org_${uuid()}`
          await store.setOrgSettings(org, { ...DEFAULT_ORG_SETTINGS, slackPost: false })
          const combined = await store.orgContext(org, "u1")
          expect(combined).toEqual({
            settings: await store.getOrgSettings(org),
            personalBrandprint: await store.getUserBrandprint("u1"),
          })
          expect(combined.settings.slackPost).toBe(false)
          expect(combined.personalBrandprint).toBe(JSON.stringify({ collectionId: "col_x" }))
          // null userId skips the user read entirely — settings alone, no error even
          // though nothing was seeded for a null id.
          expect(await store.orgContext(org, null)).toEqual({
            settings: await store.getOrgSettings(org),
            personalBrandprint: null,
          })
        },
      )
    })

    it("orgContext tolerates a user table with no brandprint column", async () => {
      await inSchema(
        async (boot, schema) => {
          // The older/minimal shape getUserBrandprint's own try/catch already tolerates —
          // orgContext's UNION must fall back the same way, not throw.
          await boot.query(
            `CREATE TABLE ${schema}."user" (id text primary key, email text, name text)`,
          )
          await boot.query(
            `INSERT INTO ${schema}."user"(id,email,name) VALUES('u1','amy@x.com','Amy')`,
          )
        },
        async (store) => {
          const org = `org_${uuid()}`
          await store.setOrgSettings(org, { ...DEFAULT_ORG_SETTINGS, emailNotifications: false })
          const combined = await store.orgContext(org, "u1")
          expect(combined.settings.emailNotifications).toBe(false)
          expect(combined.personalBrandprint).toBeNull()
        },
      )
    })
  })
} else {
  // Keep the file non-empty for the default (SQLite-only) run.
  describe("pg store", () => {
    it.skip("skipped — set DERIVE_TEST_DB=pg + TEST_DATABASE_URL to run against Postgres", () => {})
  })
}

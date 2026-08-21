import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyPassword } from "better-auth/crypto"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  bootstrapOperator,
  createLiteBackup,
  resetPassword,
  restoreLiteBackup,
  verifyLiteBackup,
} from "../src/admin"
import { anonApp, app, bearer, TEST_TOKEN } from "./helpers"

const roots: string[] = []
const temp = () => {
  const path = mkdtempSync(join(tmpdir(), "derive-admin-test-"))
  roots.push(path)
  return path
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe("Lite backup lifecycle", () => {
  it("online-snapshots SQLite, verifies blobs, and restores into an empty directory", async () => {
    const root = temp()
    const data = join(root, "data")
    mkdirSync(data)
    const live = new Database(join(data, "derive.db"))
    live.pragma("journal_mode = WAL")
    live.exec("CREATE TABLE note (value TEXT); INSERT INTO note VALUES ('safe')")
    const blob = Buffer.from("immutable artifact")
    const key = createHash("sha256").update(blob).digest("hex")
    mkdirSync(join(data, "blobs", key.slice(0, 2)), { recursive: true })
    writeFileSync(join(data, "blobs", key.slice(0, 2), key.slice(2)), blob)
    writeFileSync(join(data, ".auth-secret"), "persistent-secret")
    writeFileSync(join(data, ".org-id"), "ws_persistent")

    const backup = join(root, "backup")
    await createLiteBackup(data, backup)
    await expect(verifyLiteBackup(backup)).resolves.toMatchObject({
      format: "derive-lite-backup-v2",
      topology: "sqlite+filesystem",
      sqliteIntegrity: "ok",
    })

    const restored = join(root, "restored")
    await restoreLiteBackup(backup, restored)
    const restoredDb = new Database(join(restored, "derive.db"), { readonly: true })
    expect(restoredDb.prepare("SELECT value FROM note").pluck().get()).toBe("safe")
    restoredDb.close()
    expect(readFileSync(join(restored, "blobs", key.slice(0, 2), key.slice(2)))).toEqual(blob)
    expect(readFileSync(join(restored, ".auth-secret"), "utf8")).toBe("persistent-secret")
    expect(readFileSync(join(restored, ".org-id"), "utf8")).toBe("ws_persistent")
    live.close()
  })

  it("detects a corrupted backup", async () => {
    const root = temp()
    const data = join(root, "data")
    mkdirSync(data)
    const db = new Database(join(data, "derive.db"))
    db.exec("CREATE TABLE note (value TEXT)")
    db.close()
    writeFileSync(join(data, ".auth-secret"), "persistent-secret")
    writeFileSync(join(data, ".org-id"), "ws_persistent")
    const backup = join(root, "backup")
    await createLiteBackup(data, backup)
    writeFileSync(join(backup, "derive.db"), "not a database")
    await expect(verifyLiteBackup(backup)).rejects.toThrow(/checksum mismatch/)
  })

  it("rejects files that are not declared by the manifest", async () => {
    const root = temp()
    const data = join(root, "data")
    mkdirSync(data)
    const db = new Database(join(data, "derive.db"))
    db.exec("CREATE TABLE note (value TEXT)")
    db.close()
    writeFileSync(join(data, ".auth-secret"), "persistent-secret")
    writeFileSync(join(data, ".org-id"), "ws_persistent")
    const backup = join(root, "backup")
    await createLiteBackup(data, backup)
    writeFileSync(join(backup, ".unmanifested"), "surprise")
    await expect(verifyLiteBackup(backup)).rejects.toThrow(/inventory/)
  })

  it("rejects a manifest that smuggles an environment-supplied identity file", async () => {
    vi.stubEnv("DERIVE_AUTH_SECRET", "environment-secret-for-test")
    vi.stubEnv("DERIVE_DEFAULT_ORG_ID", "ws_environment")
    const root = temp()
    const data = join(root, "data")
    mkdirSync(data)
    const db = new Database(join(data, "derive.db"))
    db.exec("CREATE TABLE note (value TEXT)")
    db.close()
    const backup = join(root, "backup")
    await createLiteBackup(data, backup)

    const secret = "smuggled-secret"
    writeFileSync(join(backup, ".auth-secret"), secret)
    const manifestPath = join(backup, "derive-backup.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      files: { path: string; sha256: string; bytes: number }[]
    }
    manifest.files.push({
      path: ".auth-secret",
      sha256: createHash("sha256").update(secret).digest("hex"),
      bytes: Buffer.byteLength(secret),
    })
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    await expect(verifyLiteBackup(backup)).rejects.toThrow(/environment-supplied identity/)
  })
})

describe("operator password recovery", () => {
  it("updates the credential hash and revokes every session", async () => {
    const data = temp()
    const db = new Database(join(data, "derive.db"))
    db.exec(`
      CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL);
      CREATE TABLE account (id TEXT PRIMARY KEY, "accountId" TEXT NOT NULL,
        "providerId" TEXT NOT NULL, "userId" TEXT NOT NULL, password TEXT,
        "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL);
      CREATE TABLE session (id TEXT PRIMARY KEY, "userId" TEXT NOT NULL);
      INSERT INTO "user" VALUES ('u1', 'person@example.com');
      INSERT INTO account VALUES ('a1','u1','credential','u1','old','now','now');
      INSERT INTO session VALUES ('s1','u1'), ('s2','u1');
    `)
    db.close()

    await resetPassword(undefined, data, "PERSON@example.com", "new-safe-password")

    const check = new Database(join(data, "derive.db"), { readonly: true })
    const password = check.prepare("SELECT password FROM account").pluck().get() as string
    expect(await verifyPassword({ hash: password, password: "new-safe-password" })).toBe(true)
    expect(check.prepare("SELECT count(*) FROM session").pluck().get()).toBe(0)
    check.close()
  })
})

describe("instance operator bootstrap", () => {
  it("creates the account and binds authority to its immutable id", async () => {
    const data = temp()
    const result = await bootstrapOperator(undefined, data, "http://derive.test", {
      email: "Owner@Example.com",
      name: "Owner",
      password: "safe-bootstrap-password",
    })
    expect(result.created).toBe(true)
    const db = new Database(join(data, "derive.db"), { readonly: true })
    expect(
      db.prepare('SELECT id FROM "user" WHERE email = ?').pluck().get("owner@example.com"),
    ).toBe(result.userId)
    expect(db.prepare("SELECT user_id FROM instance_operator").pluck().get()).toBe(result.userId)
    db.close()

    await expect(
      bootstrapOperator(undefined, data, "http://derive.test", {
        email: "second@example.com",
        name: "Second",
        password: "safe-bootstrap-password",
      }),
    ).rejects.toThrow(/operator already exists/)
  })
})

// The operator-gated config-introspection endpoint behind `derive doctor`. The gate is
// the security-sensitive part: config posture (which features are wired, which vars are
// missing) must not leak to a non-operator.
describe("GET /v1/system/capabilities", () => {
  it("forbids a non-operator (anonymous)", async () => {
    const res = await anonApp.request("/v1/system/capabilities")
    expect(res.status).toBe(403)
  })
})

describe("POST /v1/system/search-reindex", () => {
  it("accepts cursor:null as 'start from the top' — the natural resume loop echoes the final nextCursor back", async () => {
    // A resumable client re-POSTs the previous `nextCursor`, which is literally `null` on the
    // last page. The endpoint's `cursor` is `.nullish()`, so that must be a 200 (start over),
    // not a 400 — otherwise a curl loop that doesn't special-case null wedges on its own output.
    const res = await app.request("/v1/system/search-reindex", {
      method: "POST",
      headers: { ...bearer(TEST_TOKEN), "content-type": "application/json" },
      body: JSON.stringify({ cursor: null, limit: 1 }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { scanned: number; indexed: number; nextCursor: unknown }
    expect(typeof body.scanned).toBe("number")
    expect(typeof body.indexed).toBe("number")
  })

  it("forbids a non-operator", async () => {
    const res = await anonApp.request("/v1/system/search-reindex", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 1 }),
    })
    expect(res.status).toBe(403)
  })
})

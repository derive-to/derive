import { serve } from "@hono/node-server"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import Database from "better-sqlite3"
import { Pool } from "pg"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { PgMetaStore } from "@dock/db/pg"
import type { BlobStore, MetaStore } from "@dock/core"
import { FsBlobStore } from "@dock/storage/fs"
import { s3FromUrl } from "@dock/storage/s3"
import { createApp } from "./app"
import { makeAuth, migrateAuth, type AuthDb } from "./auth-config"

const PORT = Number(process.env.PORT ?? 8080)
const DATA_DIR = process.env.DATA_DIR ?? "./data"
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`
const DATABASE_URL = process.env.DATABASE_URL

mkdirSync(join(DATA_DIR, "blobs"), { recursive: true })

// Metadata + auth share one datastore: Postgres when DATABASE_URL is set (the
// stateless multi-instance topology), else embedded SQLite (zero-config).
let meta: MetaStore
let authDb: AuthDb
if (DATABASE_URL) {
  meta = await PgMetaStore.create(DATABASE_URL)
  authDb = new Pool({ connectionString: DATABASE_URL })
} else {
  meta = new SqliteMetaStore(join(DATA_DIR, "dock.db"))
  authDb = new Database(join(DATA_DIR, "dock.db"))
}
const auth = makeAuth(authDb, BASE_URL)
await migrateAuth(auth)

const webOrigins = (process.env.DOCK_WEB_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

// Blobs: S3/R2 when OBJECT_STORE_URL is set, else local disk (zero-config).
const blobs: BlobStore = process.env.OBJECT_STORE_URL
  ? s3FromUrl(process.env.OBJECT_STORE_URL)
  : new FsBlobStore(join(DATA_DIR, "blobs"))

const app = createApp({
  meta,
  blobs,
  baseUrl: BASE_URL,
  token: process.env.DOCK_TOKEN,
  auth,
  webOrigins,
  analytics: process.env.DOCK_ANALYTICS !== "false",
})

const blobDesc = process.env.OBJECT_STORE_URL ? "S3/R2" : `local disk (${DATA_DIR})`
const metaDesc = DATABASE_URL ? "postgres" : `sqlite (${DATA_DIR})`

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`dock api listening on :${PORT}`)
  console.log(`  meta:    ${metaDesc}`)
  console.log(`  blobs:   ${blobDesc}`)
  console.log(`  auth:    /api/auth/* (Better Auth)`)
  console.log(`  publish: dock publish <file|dir> --server ${BASE_URL}`)
})

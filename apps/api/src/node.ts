import { serve } from "@hono/node-server"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import Database from "better-sqlite3"
import { SqliteMetaStore } from "@dock/db/sqlite"
import type { BlobStore } from "@dock/core"
import { FsBlobStore } from "@dock/storage/fs"
import { s3FromUrl } from "@dock/storage/s3"
import { createApp } from "./app"
import { makeAuth, migrateAuth } from "./auth-config"

const PORT = Number(process.env.PORT ?? 8080)
const DATA_DIR = process.env.DATA_DIR ?? "./data"
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`

mkdirSync(join(DATA_DIR, "blobs"), { recursive: true })

const meta = new SqliteMetaStore(join(DATA_DIR, "dock.db"))
const auth = makeAuth(new Database(join(DATA_DIR, "dock.db")), BASE_URL)
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
})

const blobDesc = process.env.OBJECT_STORE_URL ? "S3/R2" : `local disk (${DATA_DIR})`

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`dock api listening on :${PORT}`)
  console.log(`  meta:    sqlite (${DATA_DIR})`)
  console.log(`  blobs:   ${blobDesc}`)
  console.log(`  auth:    /api/auth/* (Better Auth)`)
  console.log(`  publish: dock publish <file|dir> --server ${BASE_URL}`)
})

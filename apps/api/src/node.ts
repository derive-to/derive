import { serve } from "@hono/node-server"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import { createApp } from "./app"

const PORT = Number(process.env.PORT ?? 8080)
const DATA_DIR = process.env.DATA_DIR ?? "./data"
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`

mkdirSync(join(DATA_DIR, "blobs"), { recursive: true })

const app = createApp({
  meta: new SqliteMetaStore(join(DATA_DIR, "dock.db")),
  blobs: new FsBlobStore(join(DATA_DIR, "blobs")),
  baseUrl: BASE_URL,
  token: process.env.DOCK_TOKEN,
})

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`dock api listening on :${PORT}`)
  console.log(`  storage: sqlite + local blobs (${DATA_DIR})`)
  console.log(`  publish: dock publish <file|dir> --server ${BASE_URL}`)
})

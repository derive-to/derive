// Emit Better Auth's table DDL by running its real migration against an in-memory
// SQLite (where Kysely's introspector works), then dumping the created schema.
// D1 forbids the sqlite_master introspection Better Auth's migrator does at runtime,
// so we apply this SQL to D1 offline (wrangler d1 execute) instead. Node-only tool.
//   node --experimental-strip-types gen-auth-schema.ts > /tmp/auth-schema.sql
import Database from "better-sqlite3"
import { makeAuth, migrateAuth } from "./src/auth-config.ts"

const db = new Database(":memory:")
const auth = makeAuth(db, "http://localhost:8787", "x".repeat(40))
await migrateAuth(auth)

const rows = db
  .prepare(
    "SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC",
  )
  .all() as { sql: string }[]
process.stdout.write(`${rows.map((r) => `${r.sql};`).join("\n\n")}\n`)

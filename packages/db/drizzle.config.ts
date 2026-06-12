import { defineConfig } from "drizzle-kit"

// Used by drizzle-kit to generate migrations from src/schema.ts.
// Runtime table creation still happens via SCHEMA_STATEMENTS on boot.
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
})

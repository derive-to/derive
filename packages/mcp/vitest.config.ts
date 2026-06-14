import { defineConfig } from "vitest/config"

// Coverage gate scoped to the API client (client.ts). index.ts is the stdio MCP
// server entry — it registers tools and connects a transport on import (like the
// Node app entry), so it's covered end-to-end by running the server, not by unit
// tests. The client is where the request/response logic lives. Ratchet floor.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/client.ts"],
      reporter: ["text-summary"],
      thresholds: { lines: 86, statements: 78, branches: 58 },
    },
  },
})

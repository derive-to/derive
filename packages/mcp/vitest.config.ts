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
      // Ratchet floors under current (80.9/73.8/72.2/92.8), with headroom — client.ts
      // is small (18 fns), so each unit is worth several %.
      thresholds: { statements: 75, branches: 66, functions: 66, lines: 88 },
    },
  },
})

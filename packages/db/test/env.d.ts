/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { D1Database } from "@cloudflare/workers-types"

// Types the `cloudflare:test` `env` for the D1 lane (vitest.d1.config.ts binds D1 as
// DB). `cloudflare:test` exports `env: Cloudflare.Env`, so the binding goes here.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database
  }
}

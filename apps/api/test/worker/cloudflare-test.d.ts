/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { WorkerLoader } from "@cloudflare/workers-types"

// Types the virtual `cloudflare:test` binding used by the workerd code-mode suite.
declare namespace Cloudflare {
  interface Env {
    LOADER: WorkerLoader
  }
}

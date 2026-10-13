/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { Fetcher, WorkerLoader } from "@cloudflare/workers-types"

// Types the virtual `cloudflare:test` binding used by the workerd code-mode suite.
declare namespace Cloudflare {
  interface Env {
    LOADER: WorkerLoader
    SSH_PROVIDER: Fetcher
  }
}

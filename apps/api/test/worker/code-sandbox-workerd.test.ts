import { env } from "cloudflare:test"
import type {
  WorkerLoader,
  WorkerLoaderWorkerCode,
  WorkerStub,
  WorkerStubEntrypointOptions,
} from "@cloudflare/workers-types"
import { describe, expect, it } from "vitest"
import { cloudflareSandbox } from "../../src/lib/code-sandbox-cloudflare"
import { runSandboxContract } from "../sandbox-contract"

describe("Cloudflare Dynamic Worker resource limits", () => {
  it("sets the CPU limit on both loaded code and the entrypoint invocation", async () => {
    let loaded: WorkerLoaderWorkerCode | undefined
    let entrypointOptions: WorkerStubEntrypointOptions | undefined
    const stub = {
      getEntrypoint: (_name?: string, options?: WorkerStubEntrypointOptions) => {
        entrypointOptions = options
        return {
          evaluate: async () => ({ result: 42, logs: [] }),
          [Symbol.dispose]: () => {},
        }
      },
      [Symbol.dispose]: () => {},
    } as unknown as WorkerStub
    const loader = {
      get: () => stub,
      load: (code: WorkerLoaderWorkerCode) => {
        loaded = code
        return stub
      },
    } satisfies WorkerLoader

    const result = await cloudflareSandbox(loader).run({
      code: "return 42",
      host: { toolNames: [], callTool: async () => null },
      timeoutMs: 1_234,
    })

    expect(result.value).toBe(42)
    expect(loaded?.limits?.cpuMs).toBe(1_234)
    expect(entrypointOptions?.limits?.cpuMs).toBe(1_234)
  })
})

// This suite runs the actual Cloudflare SDK executor through Miniflare's Worker Loader. It proves
// the hosted implementation, not a fake adapter, against the same contract as the Node runtime.
runSandboxContract(
  "Cloudflare Dynamic Worker sandbox",
  () => cloudflareSandbox(env.LOADER),
  // Miniflare does not enforce Dynamic Worker CPU limits. Running a tight loop would block the
  // test process forever. The test above proves both production limit injection points instead.
  { skipSynchronousLoop: true },
)

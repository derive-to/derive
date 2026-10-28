import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types"
import { describe, expect, it, vi } from "vitest"
import { log } from "../src/log"
import type { Env } from "../src/worker"
import worker from "../src/worker"

// The Workers entry must fail CLOSED when the session-signing secret is absent or
// weak: a stateless Worker can't generate+persist one like the Node path, and
// booting with a forgeable secret would let anyone mint a valid session. The check
// runs before any binding is touched, so it's unit-testable without D1/R2/DO mocks.
//
// (The successful-boot path needs the workerd runtime + real bindings and is covered
// by the wrangler-dev integration run, not here. These tests never build the app, so
// the module-level `app` singleton stays null and each assertion re-runs the check.)
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
const req = new Request("https://derive.test/")

describe("worker (edge): fail-closed auth secret", () => {
  it("throws when DERIVE_AUTH_SECRET is unset", () => {
    expect(() => worker.fetch(req, {} as Env, ctx)).toThrow(/DERIVE_AUTH_SECRET/)
  })

  it("throws when DERIVE_AUTH_SECRET is too short (< 16 chars)", () => {
    expect(() => worker.fetch(req, { DERIVE_AUTH_SECRET: "short" } as Env, ctx)).toThrow(
      /DERIVE_AUTH_SECRET/,
    )
  })
})

describe("worker scheduled job tick diagnostics", () => {
  it("keeps a failed job tick in waitUntil and redacts the platform exception", async () => {
    const pending: Promise<unknown>[] = []
    const privateError = "private database connection and task parameters"
    const info = vi.spyOn(log, "info").mockImplementation(() => {})
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {})
    try {
      worker.scheduled(
        { cron: "* * * * *", scheduledTime: Date.now() } as ScheduledController,
        {
          DERIVE_AUTH_SECRET: "scheduled-worker-test-secret",
          DERIVE_ORTAM_RUNNER_PATH: "/opt/derive/bin/derive.js",
          WEBHOOK_OUTBOX: {
            idFromName: () => "outbox",
            get: () => ({ fetch: async () => new Response("ok") }),
          },
          DB: {
            prepare: () => {
              throw Object.assign(new Error(privateError), { code: "ECONNRESET" })
            },
          },
        } as unknown as Env,
        {
          waitUntil: (work: Promise<unknown>) => pending.push(work),
        } as unknown as ExecutionContext,
      )
      const results = await Promise.allSettled(pending)
      const rejected = results.filter((r) => r.status === "rejected")
      // The tick logs its own failure rather than failing the whole scheduled invocation.
      expect(rejected).toHaveLength(0)
      expect(warn).toHaveBeenCalledWith("job tick failed", { reason: "connection" })
      expect(JSON.stringify([info.mock.calls, warn.mock.calls, rejected])).not.toContain(
        privateError,
      )
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  })
})

describe("worker (edge): auth init wait", () => {
  // A request that reaches a fresh isolate waits for Better Auth's init (worker.ts). When
  // that init stalls, the wait must end: the stall used to hold every request on the
  // isolate (a whole page load) until the browser gave up. The model below stalls an init
  // on a stuck connection; every app awaits its own init the way an auth check does.
  const env = {
    DERIVE_AUTH_SECRET: "auth-init-wait-test-secret",
    DB: {},
    HYPERDRIVE: { connectionString: "postgres://derive.test/db" },
  } as unknown as Env
  const api = () => new Request("https://derive.test/v1/me", { method: "POST" })

  const isolate = async (
    initFor: (conn: unknown, stuck: unknown) => Promise<unknown>,
    { awaitsInit = true } = {},
  ) => {
    vi.resetModules()
    vi.useFakeTimers()
    const { requestPg } = await import("../src/edge-pg")
    let stuck: unknown
    let builds = 0
    vi.doMock("../src/edge-deps", async (original) => ({
      ...(await original<typeof import("../src/edge-deps")>()),
      edgeAppDeps: () => {
        const conn = requestPg.getStore()
        stuck ??= conn
        return { auth: { $context: initFor(conn, stuck) } }
      },
    }))
    vi.doMock("../src/app", () => ({
      createApp: (deps: { auth: { $context: Promise<unknown> } }) => {
        const n = ++builds
        return {
          fetch: async () => {
            if (awaitsInit) await deps.auth.$context
            return new Response(`app ${n}`)
          },
        }
      },
    }))
    const { log: freshLog } = await import("../src/log")
    const warn = vi.spyOn(freshLog, "warn").mockImplementation(() => {})
    const { default: fresh } = await import("../src/worker")
    const send = () => Promise.resolve(fresh.fetch(api(), env, ctx))
    return { send, warn, builds: () => builds }
  }
  const restore = () => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.doUnmock("../src/edge-deps")
    vi.doUnmock("../src/app")
    vi.resetModules()
  }

  it("abandons an init stuck on its connection and serves from a rebuild on a fresh one", async () => {
    try {
      const never = new Promise<never>(() => {})
      const { send, warn, builds } = await isolate((conn, stuck) =>
        conn === stuck ? never : Promise.resolve({}),
      )
      const first = send()
      const second = send()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await (await first).text()).toBe("app 2")
      expect(await (await second).text()).toBe("app 2")
      expect(builds()).toBe(2)
      expect(warn).toHaveBeenCalledWith("auth init stalled; rebuilding the app", {
        waited_ms: 5_000,
        retried: false,
      })
      // The rebuilt app's init settled, so the next request is served without waiting.
      expect(await (await send()).text()).toBe("app 2")
    } finally {
      restore()
    }
  })

  it("answers 503 when the rebuild stalls too, and the next request builds again", async () => {
    try {
      let calls = 0
      const { send, builds } = await isolate(() =>
        ++calls < 3 ? new Promise<never>(() => {}) : Promise.resolve({}),
      )
      const first = send()
      await vi.advanceTimersByTimeAsync(10_000)
      const res = await first
      expect(res.status).toBe(503)
      expect(res.headers.get("retry-after")).toBe("1")
      expect(await (await send()).text()).toBe("app 3")
      expect(builds()).toBe(3)
    } finally {
      restore()
    }
  })

  it("keeps waiting on the rebuild when the abandoned init settles late", async () => {
    try {
      const settle: Array<() => void> = []
      // An app that never touches auth, so only the worker's own wait holds the request.
      const { send } = await isolate(
        () => new Promise((resolve) => settle.push(() => resolve({}))),
        { awaitsInit: false },
      )
      const first = send()
      await vi.advanceTimersByTimeAsync(5_000)
      settle[0]?.() // the abandoned init lands after the rebuild started
      await vi.advanceTimersByTimeAsync(0)
      let served = false
      const late = send().then((r) => {
        served = true
        return r
      })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(served).toBe(false)
      settle[1]?.()
      expect(await (await late).text()).toBe("app 2")
      expect(await (await first).text()).toBe("app 2")
    } finally {
      restore()
    }
  })
})

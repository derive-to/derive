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

describe("worker scheduled runtime diagnostics", () => {
  it("keeps a failed controller in waitUntil and redacts the platform exception", async () => {
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
          DERIVE_HOSTED_RUNS_ALLOWLIST: "pilot-workspace",
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
      expect(rejected).toHaveLength(1)
      expect(String(rejected[0]?.reason)).toBe(
        "Error: Runtime tick failed; inspect runtime dispatch diagnostics",
      )
      expect(warn).toHaveBeenCalledWith("runtime tick failed", { reason: "connection" })
      expect(JSON.stringify([info.mock.calls, warn.mock.calls, rejected])).not.toContain(
        privateError,
      )
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  })
})

describe("worker runtime queue wake-up", () => {
  it("coalesces runtime nudges in one batch and keeps controller failures redacted", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {})
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {})
    try {
      await expect(
        worker.queue(
          {
            messages: [
              { body: null },
              { body: { kind: "unknown" } },
              { body: { kind: "runtime" } },
              { body: { kind: "runtime" } },
            ],
          },
          {
            DERIVE_AUTH_SECRET: "runtime-queue-test-secret",
            DERIVE_ORTAM_RUNNER_PATH: "/opt/derive/bin/derive.js",
            DB: {
              prepare: () => {
                throw Object.assign(new Error("private queue database input"), {
                  code: "ECONNRESET",
                })
              },
            },
          } as unknown as Env,
        ),
      ).rejects.toThrow("Runtime tick failed; inspect runtime dispatch diagnostics")
      expect(
        info.mock.calls.filter(([message]) => message === "runtime tick started"),
      ).toHaveLength(1)
      expect(warn).toHaveBeenCalledWith("runtime tick failed", { reason: "connection" })
      expect(JSON.stringify([info.mock.calls, warn.mock.calls])).not.toContain(
        "private queue database input",
      )
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  })
})

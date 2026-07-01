import type { ExecutionContext } from "@cloudflare/workers-types"
import { describe, expect, it } from "vitest"
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

  it("throws on a 15-char secret but not a 16-char one (boundary)", () => {
    expect(() => worker.fetch(req, { DERIVE_AUTH_SECRET: "x".repeat(15) } as Env, ctx)).toThrow(
      /DERIVE_AUTH_SECRET/,
    )
    // A 16-char secret clears the secret gate, so failure (if any) is downstream in
    // binding setup — NOT the ">= 16 chars" guard. Either way it must not throw that.
    let msg = ""
    try {
      worker.fetch(req, { DERIVE_AUTH_SECRET: "x".repeat(16) } as Env, ctx)
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e)
    }
    expect(msg).not.toMatch(/DERIVE_AUTH_SECRET/)
  })
})

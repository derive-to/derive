import { describe, expect, it, vi } from "vitest"
import { loadDispatcherConfig } from "../src/config"
import type { invokeHostedAgent } from "../src/invoke"
import { buildServer, parseInvoke } from "../src/server"

const cfg = (secret: string | null) => {
  const c = loadDispatcherConfig({
    DATABASE_URL: "postgres://x/y",
    DISPATCHER_CONTEXTS: JSON.stringify([{ id: "ctx_a", token_env: "T" }]),
    ...(secret ? { DISPATCHER_HOST_SECRET: secret } : {}),
  })
  return c
}

const validBody = {
  agentToken: "dk_agt_x",
  manifest: "You maintain docs.",
  task: "Refresh the status line.",
  trigger: "draft",
  autonomy: "suggest",
  flags: { agentKillswitch: false, agentAutoEnabled: false },
}

const throwModel = () => {
  throw new Error("no model")
}

describe("parseInvoke", () => {
  it("accepts a well-formed body and rejects each missing/invalid field", () => {
    expect(parseInvoke(validBody)).toMatchObject({ agentToken: "dk_agt_x", autonomy: "suggest" })
    expect(parseInvoke({ ...validBody, agentToken: "" })).toMatch(/agentToken/)
    expect(parseInvoke({ ...validBody, manifest: undefined })).toMatch(/manifest/)
    expect(parseInvoke({ ...validBody, task: "" })).toMatch(/task/)
    expect(parseInvoke({ ...validBody, autonomy: "yolo" })).toMatch(/autonomy/)
    expect(parseInvoke({ ...validBody, flags: { agentKillswitch: true } })).toMatch(/flags/)
    expect(parseInvoke("nope")).toMatch(/object/)
  })
})

describe("the hosted-lane HTTP surface", () => {
  it("health is unauthenticated", async () => {
    const app = buildServer({ cfg: cfg("s3cr3t"), resolveModel: throwModel })
    const res = await app.request("/internal/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("invoke rejects a missing or wrong secret", async () => {
    const app = buildServer({ cfg: cfg("s3cr3t"), resolveModel: throwModel })
    const noSecret = await app.request("/internal/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    })
    expect(noSecret.status).toBe(401)
    const wrong = await app.request("/internal/invoke", {
      method: "POST",
      headers: { "content-type": "application/json", "x-derive-host-secret": "nope" },
      body: JSON.stringify(validBody),
    })
    expect(wrong.status).toBe(401)
  })

  it("a configured-off hosted lane fails closed with 500", async () => {
    const app = buildServer({ cfg: cfg(null), resolveModel: throwModel })
    const res = await app.request("/internal/invoke", {
      method: "POST",
      headers: { "content-type": "application/json", "x-derive-host-secret": "anything" },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(500)
  })

  it("with the right secret, a valid body reaches the invoke handler", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ text: "done" }) as unknown as typeof invokeHostedAgent
    const app = buildServer({ cfg: cfg("s3cr3t"), resolveModel: throwModel, invoke })
    const res = await app.request("/internal/invoke", {
      method: "POST",
      headers: { "content-type": "application/json", "x-derive-host-secret": "s3cr3t" },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: "done" })
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ server: "https://derive.to" }),
      expect.objectContaining({ agentToken: "dk_agt_x", task: validBody.task }),
    )
  })

  it("a bad body is a 400 after auth passes", async () => {
    const app = buildServer({ cfg: cfg("s3cr3t"), resolveModel: throwModel })
    const res = await app.request("/internal/invoke", {
      method: "POST",
      headers: { "content-type": "application/json", "x-derive-host-secret": "s3cr3t" },
      body: JSON.stringify({ ...validBody, autonomy: "bogus" }),
    })
    expect(res.status).toBe(400)
  })

  it("drain-runs is behind the same secret and reaches the executor", async () => {
    const drain = vi.fn().mockResolvedValue({ claimed: 3, finished: 2, failed: 1 })
    const app = buildServer({ cfg: cfg("s3cr3t"), resolveModel: throwModel, drain })
    // Wrong secret: rejected.
    const denied = await app.request("/internal/drain-runs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-derive-host-secret": "nope" },
      body: JSON.stringify({ agentToken: "dk_agt_x", manifest: "m" }),
    })
    expect(denied.status).toBe(401)
    // Right secret + a valid body reaches the executor.
    const ok = await app.request("/internal/drain-runs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-derive-host-secret": "s3cr3t" },
      body: JSON.stringify({ agentToken: "dk_agt_x", manifest: "m" }),
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ claimed: 3, finished: 2, failed: 1 })
    expect(drain).toHaveBeenCalledWith(expect.objectContaining({ agentToken: "dk_agt_x" }))
    // A missing agentToken is a 400 after auth.
    const bad = await app.request("/internal/drain-runs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-derive-host-secret": "s3cr3t" },
      body: JSON.stringify({ manifest: "m" }),
    })
    expect(bad.status).toBe(400)
  })
})

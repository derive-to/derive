import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, api } from "@/api"

const REFUSAL =
  "You need permission to create things in this workspace before you can set up a context here. An Admin can change your access under Settings › Members."

const rejectWith = async (status: number, body: unknown): Promise<ApiError> => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status, json: async () => body }) as unknown as Response),
  )
  return api
    .createChatSession({
      workspace: "default",
      body_md: "a pricing helper",
      purpose: "context_builder",
    })
    .then(() => {
      throw new Error("expected request to fail")
    })
    .catch((error: unknown) => error as ApiError)
}

afterEach(() => vi.unstubAllGlobals())

describe("builder session refusals", () => {
  it("preserves an actionable server message", async () => {
    const error = await rejectWith(403, { error: REFUSAL })
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(403)
    expect(error.message).toBe(REFUSAL)
    expect(error.message).not.toMatch(/^[[{]|HTTP \d|manifest|short id/i)
  })

  it("preserves the 404 used to switch to degraded mode", async () => {
    expect((await rejectWith(404, { error: "not found" })).status).toBe(404)
  })
})

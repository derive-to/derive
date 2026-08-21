import { afterEach, describe, expect, it, vi } from "vitest"
import { json } from "./use-chat-session"

// WHAT A REFUSAL SAYS WHEN IT REACHES A PERSON.
//
// Every chat surface refuses through this one helper: chat not enabled, not a member of the
// workspace, asking too fast, over budget, no model configured. Each of those is a sentence
// somebody can act on, and each is worthless if the surface prints a status code instead — which
// is exactly what happened, because the API answers `{ error }` (lib/http's `fail`) and this read
// only `{ message }`. Every one of those refusals arrived as "/v1/chat-session failed (503)".

const mockFetch = (status: number, body: unknown) => {
  const res = {
    ok: status >= 200 && status < 300,
    status,
    clone: () => res,
    json: async () => body,
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => res as unknown as Response),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe("the chat fetch helper", () => {
  it("surfaces the API's own sentence, which it sends as `error`", async () => {
    mockFetch(503, { error: "no model is configured on this deploy" })
    await expect(json("/v1/chat-session")).rejects.toThrow("no model is configured on this deploy")
  })

  it("still reads `message`, for the routes shaped that way", async () => {
    mockFetch(403, { message: "chat is not enabled for this workspace" })
    await expect(json("/v1/chat-session")).rejects.toThrow("chat is not enabled for this workspace")
  })

  it("falls back to the status only when the body says nothing", async () => {
    mockFetch(500, {})
    await expect(json("/v1/sessions/abc")).rejects.toThrow("/v1/sessions/abc failed (500)")
  })

  it("does not choke when the error body is not JSON at all", async () => {
    const res = {
      ok: false,
      status: 502,
      clone: () => res,
      json: async () => {
        throw new Error("not json")
      },
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res as unknown as Response),
    )
    await expect(json("/v1/chat-session")).rejects.toThrow("/v1/chat-session failed (502)")
  })
})

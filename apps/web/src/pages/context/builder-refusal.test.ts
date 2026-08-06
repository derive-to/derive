import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, api } from "@/api"

// THE TWO WAYS THE GUIDED DOOR CAN BE CLOSED, and why the page treats them differently.
//
// 404 — this deploy or this workspace has no built-in chat. Nobody here can hold the
// conversation, so the page hides the composer and leads with the agent door (`degraded`).
//
// 403 — the conversation works fine; THIS person's access is read-only, and creating a context
// needs more than that (routes/contexts.ts checks it before the first question rather than
// letting the interview run and fail at the end). Hiding the composer would be wrong: the other
// doors refuse for exactly the same reason, so there is nowhere useful to send them. What they
// need is the server's own sentence, which names the fix — and that only reaches them if the
// client surfaces the BODY rather than the status code, which is what this pins down.

const stub = (status: number, body: unknown) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        ({
          ok: status >= 200 && status < 300,
          status,
          json: async () => body,
        }) as unknown as Response,
    ),
  )
}

afterEach(() => vi.unstubAllGlobals())

const REFUSAL =
  "You need permission to create things in this workspace before you can set up a context here. An Admin can change your access under Settings › Members."

describe("opening the guided builder when it is refused", () => {
  it("carries the server's sentence, not a status code or a blob of JSON", async () => {
    stub(403, { error: REFUSAL })
    const err = await api
      .createBuilderSession({ workspace: "default", body_md: "a pricing helper" })
      .then(() => null)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(403)
    // What the composer's notice ends up rendering: a sentence a person can act on.
    expect((err as ApiError).message).toBe(REFUSAL)
    expect((err as ApiError).message).not.toMatch(/^[[{]/)
    expect((err as ApiError).message).not.toMatch(/HTTP \d|manifest|short id/i)
  })

  it("still tells 404 apart, which is the one that swaps the page over", async () => {
    stub(404, { error: "not found" })
    const err = await api
      .createBuilderSession({ workspace: "default", body_md: "a pricing helper" })
      .then(() => null)
      .catch((e: unknown) => e)
    expect((err as ApiError).status).toBe(404)
  })
})

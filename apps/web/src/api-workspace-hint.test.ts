import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, api } from "./api"

afterEach(() => vi.unstubAllGlobals())

describe("workspace mismatch API hint", () => {
  it("preserves the validated destination on an artifact refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "Switch workspaces to view this artifact.",
              code: "workspace_mismatch",
              workspace: { id: "ws_a", name: "Acme", personal: false },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
      ),
    )

    const error = await api.getArtifact("private-doc").catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 409,
      code: "workspace_mismatch",
      workspace: { id: "ws_a", name: "Acme", personal: false },
    })
  })

  it("drops malformed workspace metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "not found",
              code: "workspace_mismatch",
              workspace: { id: "ws_a" },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
      ),
    )

    const error = (await api
      .getArtifact("private-doc")
      .catch((cause: unknown) => cause)) as ApiError
    expect(error.workspace).toBeUndefined()
  })
})

describe("builder session refusals", () => {
  const REFUSAL =
    "You need permission to create things in this workspace before you can set up a Context here. An Admin can change your access under Settings › Members."

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

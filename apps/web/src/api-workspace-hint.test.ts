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

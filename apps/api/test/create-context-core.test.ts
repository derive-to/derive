import { describe, expect, it, vi } from "vitest"
import { ContextConflictError, createContextCore } from "../src/lib/create-context"
import { as, makeAuthedApp, publishAs } from "./helpers"

const owner = { id: "u-ow", email: "ow@x.com", name: "Ow" }

describe("createContextCore", () => {
  it("mints a managed agent and writes the context row", async () => {
    const { app, meta } = makeAuthedApp("ctx-core", [owner])
    await app.request("/v1/me", { headers: as(owner.email) })
    const pub = await (await publishAs(app, "# A manifest", {}, as(owner.email))).json()
    const artifactId = (await meta.getByShortId(pub.short_id))?.id as string

    const made = await createContextCore(meta, {
      orgId: "default",
      userId: owner.id,
      name: "Pricing Helper",
      manifestArtifactId: artifactId,
    })
    expect(made.context.name).toBe("Pricing Helper")
    const agent = await meta.getAgent(made.agentId)
    expect(agent?.managed).toBeTruthy()
    // The minted token never leaves this function — only its hash is stored, and no caller
    // has anywhere safe to put the plaintext.
    expect(made).not.toHaveProperty("agentToken")
  })

  it("second create with the same name conflicts", async () => {
    const { app, meta } = makeAuthedApp("ctx-core-dup", [owner])
    await app.request("/v1/me", { headers: as(owner.email) })
    const pub = await (await publishAs(app, "# M", {}, as(owner.email))).json()
    const artifactId = (await meta.getByShortId(pub.short_id))?.id as string
    const input = {
      orgId: "default",
      userId: owner.id,
      name: "Dup",
      manifestArtifactId: artifactId,
    }
    await createContextCore(meta, input)
    await expect(createContextCore(meta, input)).rejects.toBeInstanceOf(ContextConflictError)
  })

  // The two failures this function must keep apart. Only a CONTEXT insert that fails after
  // the mint already succeeded is a naming problem; a mint that fails outright is a store
  // problem, and callers turn ContextConflictError into "that name is already taken". Wrapping
  // both would tell someone to rename their way out of a dead database.
  it("a mint failure is not mistaken for a name collision", async () => {
    const { app, meta } = makeAuthedApp("ctx-core-mint-fail", [owner])
    await app.request("/v1/me", { headers: as(owner.email) })
    const pub = await (await publishAs(app, "# Mint fail", {}, as(owner.email))).json()
    const artifactId = (await meta.getByShortId(pub.short_id))?.id as string
    vi.spyOn(meta, "createAgent").mockRejectedValue(new Error("db unavailable"))
    const err: unknown = await createContextCore(meta, {
      orgId: "default",
      userId: owner.id,
      name: "Mint Fail",
      manifestArtifactId: artifactId,
    }).catch((e) => e)
    vi.restoreAllMocks()
    expect(err).not.toBeInstanceOf(ContextConflictError)
    expect((err as Error).message).toBe("db unavailable")
  })
})

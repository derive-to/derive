import { describe, expect, it } from "vitest"
import { createContextCore } from "../src/lib/create-context"
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
    expect(made.agentToken).toMatch(/^dk_agt_/)
    const agent = await meta.getAgent(made.agentId)
    expect(agent?.managed).toBeTruthy()
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
    await expect(createContextCore(meta, input)).rejects.toThrow()
  })
})

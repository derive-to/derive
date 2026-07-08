/**
 * Verify that the artifact list endpoint exposes has_preview correctly:
 *   - true when the artifact's CURRENT version has preview_status = 'ready'
 *   - false when not ready (or no preview at all)
 */
import { describe, expect, it } from "vitest"
import { as, makeAuthedApp, publishAs } from "./helpers"

const users = [{ id: "hp-owner", email: "hp-owner@x.test", name: "Owner" }]

describe("has_preview on the artifact list", () => {
  it("returns false when no preview has been set", async () => {
    const { app } = makeAuthedApp("has-preview-false", users)
    const res = await publishAs(app, "<h1>No preview</h1>", {}, as("hp-owner@x.test"))
    const created = await res.json()
    const short_id = created.short_id

    const list = await (
      await app.request("/v1/artifacts", { headers: as("hp-owner@x.test") })
    ).json()
    const row = list.artifacts.find((a: { short_id: string }) => a.short_id === short_id)
    expect(row).toBeDefined()
    expect(row.has_preview).toBe(false)
  })

  it("returns true when the current version preview_status is ready", async () => {
    const { app, meta } = makeAuthedApp("has-preview-true", users)
    const res = await publishAs(app, "<h1>Has preview</h1>", {}, as("hp-owner@x.test"))
    const created = await res.json()
    const short_id = created.short_id

    // Look up the artifact's internal id + current_version so we can set the preview
    const ar = await meta.getByShortId(short_id)
    if (!ar) throw new Error("artifact not found")

    await meta.setVersionPreview(ar.id, ar.current_version, {
      preview_key: "test-png-key",
      preview_status: "ready",
    })

    const list = await (
      await app.request("/v1/artifacts", { headers: as("hp-owner@x.test") })
    ).json()
    const row = list.artifacts.find((a: { short_id: string }) => a.short_id === short_id)
    expect(row).toBeDefined()
    expect(row.has_preview).toBe(true)
  })

  it("returns false when an old version is ready but the current version is not", async () => {
    const { app, meta } = makeAuthedApp("has-preview-old-version", users)
    // Publish v1
    const res = await publishAs(app, "<h1>v1</h1>", {}, as("hp-owner@x.test"))
    const created = await res.json()
    const short_id = created.short_id

    const ar = await meta.getByShortId(short_id)
    if (!ar) throw new Error("artifact not found")

    // Mark v1 ready
    await meta.setVersionPreview(ar.id, 1, { preview_key: "v1-png", preview_status: "ready" })

    // Publish v2 (no preview)
    await publishAs(app, "<h1>v2</h1>", {}, as("hp-owner@x.test"), short_id)

    const list = await (
      await app.request("/v1/artifacts", { headers: as("hp-owner@x.test") })
    ).json()
    const row = list.artifacts.find((a: { short_id: string }) => a.short_id === short_id)
    expect(row).toBeDefined()
    // v1 was ready but v2 (current) is not
    expect(row.has_preview).toBe(false)
  })
})

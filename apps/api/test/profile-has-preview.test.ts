/**
 * Verify that the profile work-list endpoint (/v1/users/:handle/artifacts)
 * exposes has_preview the same way the library list does:
 *   - false when no preview has been set
 *   - true  when the artifact's CURRENT version has preview_status = 'ready'
 *   - false when an old version is ready but the current version is not
 */
import { describe, expect, it } from "vitest"
import { as, makeAuthedApp, publishAs } from "./helpers"

// A user with a pre-set username so the profile endpoint resolves without
// an extra /v1/me/username call.
const users = [
  { id: "php-owner", email: "php-owner@x.test", name: "Owner", username: "php-handle" },
]

describe("has_preview on the profile work-list", () => {
  it("returns false when no preview has been set", async () => {
    const { app } = makeAuthedApp("php-false", users)
    // Publish with explicit public visibility so the work shows on the profile.
    const res = await publishAs(
      app,
      "<h1>No preview</h1>",
      { visibility: "public" },
      as("php-owner@x.test"),
    )
    const created = await res.json()

    const list = await (
      await app.request("/v1/users/php-handle/artifacts", { headers: as("php-owner@x.test") })
    ).json()
    const row = list.artifacts.find((a: { short_id: string }) => a.short_id === created.short_id)
    expect(row).toBeDefined()
    expect(row.has_preview).toBe(false)
  })

  it("returns true when the current version preview_status is ready", async () => {
    const { app, meta } = makeAuthedApp("php-true", users)
    const res = await publishAs(
      app,
      "<h1>Has preview</h1>",
      { visibility: "public" },
      as("php-owner@x.test"),
    )
    const created = await res.json()

    const ar = await meta.getByShortId(created.short_id)
    if (!ar) throw new Error("artifact not found")
    await meta.setVersionPreview(ar.id, ar.current_version, {
      preview_key: "test-png-key",
      preview_status: "ready",
    })

    const list = await (
      await app.request("/v1/users/php-handle/artifacts", { headers: as("php-owner@x.test") })
    ).json()
    const row = list.artifacts.find((a: { short_id: string }) => a.short_id === created.short_id)
    expect(row).toBeDefined()
    expect(row.has_preview).toBe(true)
  })

  it("returns false when an old version is ready but the current version is not", async () => {
    const { app, meta } = makeAuthedApp("php-old-ver", users)
    const res = await publishAs(
      app,
      "<h1>v1</h1>",
      { visibility: "public" },
      as("php-owner@x.test"),
    )
    const created = await res.json()

    const ar = await meta.getByShortId(created.short_id)
    if (!ar) throw new Error("artifact not found")
    // Mark v1 ready
    await meta.setVersionPreview(ar.id, 1, { preview_key: "v1-png", preview_status: "ready" })
    // Publish v2 (no preview)
    await publishAs(app, "<h1>v2</h1>", {}, as("php-owner@x.test"), created.short_id)

    const list = await (
      await app.request("/v1/users/php-handle/artifacts", { headers: as("php-owner@x.test") })
    ).json()
    const row = list.artifacts.find((a: { short_id: string }) => a.short_id === created.short_id)
    expect(row).toBeDefined()
    // v1 was ready but v2 (current) is not
    expect(row.has_preview).toBe(false)
  })
})

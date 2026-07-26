import { describe, expect, it } from "vitest"
import { app, as, makeAuthedApp, meta, type TestUser, upload } from "./helpers"

const idOf = async (res: Response): Promise<string> => (await res.json()).short_id

// White-label (GTM step 08): one workspace flag hides the Made-with-Derive marks
// on the shared surfaces and unlocks the bare embed. Free workspaces keep the
// badge everywhere — including when they ask for ?chrome=none.
describe("white-label", () => {
  it("defaults off: detail carries badge true, embed carries the plaque", async () => {
    const short = await idOf(await upload("w.md", "# Hi", { visibility: "public", title: "W" }))
    const detail = await (await app.request(`/v1/artifacts/${short}`)).json()
    expect(detail.badge).toBe(true)

    const shell = await (await app.request(`/v1/embed/${short}`)).text()
    expect(shell).toContain("Made on Derive")
  })

  it("ignores ?chrome=none for a workspace without white-label", async () => {
    const short = await idOf(await upload("wc.md", "# Hi", { visibility: "public", title: "WC" }))
    const shell = await (await app.request(`/v1/embed/${short}?chrome=none`)).text()
    // The bare frame is the paid affordance; free embeds keep the plaque.
    expect(shell).toContain("Made on Derive")
  })

  it("white-label on: badge false, plaque gone, chrome=none honored", async () => {
    const short = await idOf(await upload("wl.md", "# Hi", { visibility: "public", title: "WL" }))
    const cur = await meta.getOrgSettings("default")
    await meta.setOrgSettings("default", { ...cur, whiteLabel: true })
    try {
      const detail = await (await app.request(`/v1/artifacts/${short}`)).json()
      expect(detail.badge).toBe(false)

      const shell = await (await app.request(`/v1/embed/${short}`)).text()
      expect(shell).not.toContain("Made on Derive")
      expect(shell).toContain("<iframe") // still the framed shell, just unbranded

      const bare = await (await app.request(`/v1/embed/${short}?chrome=none`)).text()
      expect(bare).not.toContain("Made on Derive")
      expect(bare).not.toContain('class="c"') // bareShell: no frame chrome at all
    } finally {
      await meta.setOrgSettings("default", { ...cur, whiteLabel: false })
    }
  })

  it("admins flip it over PATCH /v1/workspace/settings; the merge keeps other keys", async () => {
    const ada: TestUser = { id: "u_wl_ada", email: "wlada@d.test", name: "Ada" }
    const { app: authed } = makeAuthedApp("white-label", [ada])
    const res = await authed.request("/v1/workspace/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(ada.email) },
      body: JSON.stringify({ whiteLabel: true }),
    })
    expect(res.status).toBe(200)
    const settings = await res.json()
    expect(settings.whiteLabel).toBe(true)
    // Untouched keys keep their defaults — the PATCH is a merge, not a replace.
    expect(settings.emailNotifications).toBe(true)
  })
})

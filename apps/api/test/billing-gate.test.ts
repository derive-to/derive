import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MetaStore } from "@derive/core"
import { afterAll, describe, expect, it } from "vitest"
import { FakeBilling, subscriptionRow } from "./fake-billing"
import { app, as, jsonAs, makeAuthedApp, meta, publishAs, type TestUser, upload } from "./helpers"
import { appWithGrant, call, toolIsError, toolText } from "./mcp-helpers"

const u = (n: number): TestUser => ({ id: `u${n}`, email: `u${n}@x.test`, name: `U${n}` })
const FOUR = [u(1), u(2), u(3), u(4)]
const THREE = [u(1), u(2), u(3)]
const PAST = "2000-01-01T00:00:00Z"

const seedSub = async (meta: MetaStore, status: string, orgId = "default") =>
  meta.upsertSubscription(subscriptionRow({ org_id: orgId, status }))

describe("billing gate", () => {
  it("beta: 4 editor seats publish freely", async () => {
    const { app } = makeAuthedApp("bg_beta", FOUR, "editor", {
      deps: { billing: new FakeBilling() },
    })
    const r = await publishAs(app, "hello", {}, as("u2@x.test"))
    expect(r.status).toBe(201)
  })

  it("enforced + 4 seats + no sub: publish 402 billing_required", async () => {
    const { app } = makeAuthedApp("bg_needs", FOUR, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    const r = await publishAs(app, "hello", {}, as("u2@x.test"))
    expect(r.status).toBe(402)
    expect((await r.json()).code).toBe("billing_required")
  })

  it("enforced + 3 seats: publish stays open", async () => {
    const { app } = makeAuthedApp("bg_three", THREE, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    expect((await publishAs(app, "hello", {}, as("u2@x.test"))).status).toBe(201)
  })

  it("enforced + active sub: 4 seats publish", async () => {
    const { app, meta } = makeAuthedApp("bg_active", FOUR, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await seedSub(meta, "active")
    expect((await publishAs(app, "hello", {}, as("u2@x.test"))).status).toBe(201)
  })

  it("enforced + canceled sub: read-only lapse, even at 3 seats", async () => {
    const { app, meta } = makeAuthedApp("bg_lapsed", THREE, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await seedSub(meta, "canceled")
    const r = await publishAs(app, "hello", {}, as("u2@x.test"))
    expect(r.status).toBe(402)
    expect((await r.json()).code).toBe("billing_lapsed")
  })

  it("an active Team sub lifts a tiny fallback storage cap to the tier cap", async () => {
    const { app, meta } = makeAuthedApp("bg_cap", THREE, "editor", {
      deps: { billing: new FakeBilling(), maxBytes: 10 },
    })
    const blocked = await publishAs(app, "x".repeat(100), {}, as("u2@x.test"))
    expect(blocked.status).toBe(413)
    await seedSub(meta, "active")
    expect((await publishAs(app, "x".repeat(100), {}, as("u2@x.test"))).status).toBe(201)
  })

  // Restore and draft claim both record a publish without going through the main
  // publish route, so each needs its own gate (the third such path, the MCP brandprint
  // scaffold, is covered in the /mcp describe below). Seeded THREE members (never four)
  // so the workspace is only ever lapsed by a canceled subscription, never incidentally
  // over the free seat limit — isolates the choke point under test.

  it("blocked workspace: version restore refuses with 402 billing_lapsed", async () => {
    const { app, meta } = makeAuthedApp("bg_restore", THREE, "editor", {
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    const pub = await publishAs(app, "v1", {}, as("u1@x.test"))
    expect(pub.status).toBe(201)
    const { short_id } = await pub.json()
    expect((await publishAs(app, "v2", {}, as("u1@x.test"), short_id)).status).toBe(201)
    // Lapse AFTER the artifact + history exist, so only the restore itself is under test.
    await seedSub(meta, "canceled")
    const res = await app.request(
      `/v1/artifacts/${short_id}/restore`,
      jsonAs(as("u1@x.test"), { version: 1 }),
    )
    expect(res.status).toBe(402)
    expect((await res.json()).code).toBe("billing_lapsed")
  })

  it("white-label honors entitlement: beta yes, enforced-free no, subscribed yes", async () => {
    const boot = async (name: string, enforce: boolean) => {
      const made = makeAuthedApp(name, THREE, "editor", {
        deps: { billing: new FakeBilling(), ...(enforce ? { billingEnforceAt: PAST } : {}) },
      })
      const settings = await made.meta.getOrgSettings("default")
      await made.meta.setOrgSettings("default", { ...settings, whiteLabel: true })
      const pub = await publishAs(made.app, "hello", {}, as("u2@x.test"))
      const { short_id } = await pub.json()
      return { ...made, short_id }
    }
    // Beta: the toggle works (badge false = no Made-with-Derive mark).
    const beta = await boot("wl_beta", false)
    const betaDetail = await (
      await beta.app.request(`/v1/artifacts/${beta.short_id}`, { headers: as("u1@x.test") })
    ).json()
    expect(betaDetail.badge).toBe(false)
    // Enforced without a sub: toggle set but not entitled, badge comes back.
    const enforced = await boot("wl_enforced", true)
    const enforcedDetail = await (
      await enforced.app.request(`/v1/artifacts/${enforced.short_id}`, { headers: as("u1@x.test") })
    ).json()
    expect(enforcedDetail.badge).toBe(true)
    // Same workspace with an active sub: entitled again.
    await seedSub(enforced.meta, "active")
    const paidDetail = await (
      await enforced.app.request(`/v1/artifacts/${enforced.short_id}`, { headers: as("u1@x.test") })
    ).json()
    expect(paidDetail.badge).toBe(false)
  })

  it("blocked destination workspace: anonymous draft claim refuses with 402", async () => {
    const { app: drafts, meta } = makeAuthedApp("bg_claim", THREE, "editor", {
      deps: {
        subdomainBase: "bg-claim.test",
        encryptionKey: "0".repeat(64),
        billing: new FakeBilling(),
        billingEnforceAt: PAST,
      },
    })
    // Minting an anonymous draft is exempt (it lands in the system drafts org, not a
    // billed workspace) — only the CLAIM, which moves it into the caller's workspace,
    // should be gated. Lapse the destination before the claim so only the claim itself
    // (not the mint) is under test.
    await seedSub(meta, "canceled")
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("<h1>hi</h1>")]), "page.html")
    const minted = await drafts.request("/v1/drafts", { method: "POST", body: form })
    expect(minted.status).toBe(201)
    const { claim_url } = await minted.json()
    const token = (claim_url as string).split("/claim/")[1]
    const res = await drafts.request("/v1/drafts/claim", {
      method: "POST",
      headers: { "content-type": "application/json", ...as("u1@x.test") },
      body: JSON.stringify({ token }),
    })
    expect(res.status).toBe(402)
    expect((await res.json()).code).toBe("billing_lapsed")
  })
})

// White-label (GTM step 08): one workspace flag hides the Made-with-Derive marks
// on the shared surfaces and unlocks the bare embed. Free workspaces keep the
// badge everywhere — including when they ask for ?chrome=none.
describe("the white-label workspace flag", () => {
  const idOf = async (res: Response): Promise<string> => (await res.json()).short_id

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
})

// ---- MCP brand-profile scaffold ---------------------------------------------------
//
// resolveBrandprintProfileTarget (mcp-tools/publish.ts) scaffolds the Brandprint slot
// (a collection create + a placeholder publishVersion) the first time an Admin/Owner
// publishes to derive://brandprint/profile. That scaffold write runs BEFORE the tool's
// own billing gate, so a billing-blocked workspace could still get the scaffold's
// live writes. Driven
// through the real /mcp JSON-RPC surface (not just the underlying function) because
// that IS the only route this scaffold is reachable through — there is no separate
// HTTP endpoint (the old setup_brandprint tool was folded into publish) — mirroring the
// harness test/mcp.test.ts already uses for this exact tool.
const mcpDir = mkdtempSync(join(tmpdir(), "derive-bg-mcp-"))
afterAll(() => rmSync(mcpDir, { recursive: true, force: true }))

describe("MCP brandprint scaffold billing gate", () => {
  it("blocked workspace: publishing derive://brandprint/profile refuses before scaffolding", async () => {
    const { app, token, meta } = appWithGrant(
      mcpDir,
      "bp-billing",
      "openid derive:read derive:publish derive:manage",
      { billing: new FakeBilling(), billingEnforceAt: PAST },
    )
    // Learn the grantor's default (personal) workspace, then lapse it — same
    // sequencing as the restore/claim tests above (block AFTER setup, isolating the
    // scaffold write itself).
    const ws = JSON.parse(toolText(await call(app, token, "list_workspaces")))
    const org = (ws.workspaces as { id: string; default: boolean }[]).find((w) => w.default)
      ?.id as string
    await seedSub(meta, "canceled", org)

    const out = await call(app, token, "publish", {
      short_id: "derive://brandprint/profile",
      content: "<h1>Derive brand profile</h1>",
    })
    expect(toolIsError(out)).toBe(true)
    expect(toolText(out)).toContain("plan has lapsed")
    expect(toolText(out)).toMatch(/\/settings\/billing/)

    // No scaffold write happened: no brandprint pointer persisted, no collection made.
    const settings = await meta.getOrgSettings(org)
    expect(settings.brandprint?.profileId).toBeFalsy()
  })
})

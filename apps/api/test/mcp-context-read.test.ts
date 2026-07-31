import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// READING a context: a context is a PACKAGE (manifest + pinned skills + sources), and
// `read` loads it — the mode that had no way in. The surface previously described contexts
// as ask-only, and `find` went further and told callers a context row is "never
// read/opened", so the package was only assemblable by hand from its manifest short_id.
//
// The two properties worth pinning here are the ones that could go quietly wrong:
//   ACCESS  — reading is gated on canUserAskContext, the SAME grant `find` filters on, so
//             `read` can never open a package `find` would not have shown. A second access
//             path to workspace-scoped material is exactly the bug to avoid.
//   PARITY  — the skills a reader is told about are the skills a RUN would materialize,
//             staleness included, because both go through parseManifestSkillPins.

const owner: TestUser = { id: "u_cxr_own", email: "cxrown@derive.test", name: "Owner" }
const dev: TestUser = { id: "u_cxr_dev", email: "cxrdev@derive.test", name: "Dev" }

type App = ReturnType<typeof makeAuthedApp>["app"]

const callRaw = async (
  app: App,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  })
  const ct = res.headers.get("content-type") ?? ""
  const txt = await res.text()
  const out = ct.includes("application/json")
    ? JSON.parse(txt)
    : JSON.parse(
        (txt.split("\n").find((l) => l.startsWith("data:")) ?? "data:null").slice(5).trim(),
      )
  const r = out?.result as { content?: { text: string }[]; isError?: boolean } | undefined
  const t = r?.content?.[0]?.text
  if (t == null) throw new Error(`no tool text: ${JSON.stringify(out)}`)
  return { text: t, isError: !!r?.isError }
}
const call = async (
  app: App,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
  // biome-ignore lint/suspicious/noExplicitAny: test convenience over a JSON payload
): Promise<any> => JSON.parse((await callRaw(app, token, name, args)).text)

/** owner registers both agents (Admin-only); dev authors the manifest and creates the
 *  context, so dev is CREATOR and owner is a plain member — the interesting side of the
 *  ask gate, mirroring mcp-contexts.test.ts. */
const setup = async (name: string, manifestBody: string) => {
  const made = makeAuthedApp(name, [owner, dev], "editor")
  const { app } = made
  await app.request("/v1/me", { headers: as(owner.email) })
  await app.request("/v1/me", { headers: as(dev.email) })
  const answering = await (
    await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Analyst" }))
  ).json()
  const ownerBot = await (
    await app.request("/v1/agents", jsonAs(as(owner.email), { name: "OwnerBot" }))
  ).json()
  const manifest = await (
    await publishAs(app, manifestBody, { title: "Analytics manifest" }, as(dev.email))
  ).json()
  const cx = await (
    await app.request(
      "/v1/contexts",
      jsonAs(as(dev.email), {
        name: "Analytics",
        agent_id: answering.id,
        manifest_short_id: manifest.short_id,
      }),
    )
  ).json()
  const invite = async () =>
    app.request(`/v1/contexts/${cx.id}/askers`, jsonAs(as(dev.email), { email: owner.email }))
  return { app, cx, manifest, ownerToken: ownerBot.token as string, invite }
}

describe("read — a context opens as a package", () => {
  it("is gated on the ask grant: unreachable before the invite, the package after", async () => {
    const { app, cx, ownerToken, invite } = await setup("cxr-gate", "# Analytics manifest\n\nBody.")

    // Default ask_policy is `invited` (creator + roster). owner is a plain member, so the
    // context is not askable — and must not be readable either, or `read` would be a second
    // way into material the ask gate withholds.
    const denied = await callRaw(app, ownerToken, "read", { short_id: cx.id })
    expect(denied.isError).toBe(true)
    expect(denied.text).toMatch(/No context/i)

    expect((await invite()).status).toBe(201)

    const pkg = await call(app, ownerToken, "read", { short_id: cx.id })
    expect(pkg.context.id).toBe(cx.id)
    expect(pkg.context.name).toBe("Analytics")
    // Reading never needs a runner — the context has never polled, and that is fine.
    expect(pkg.context.online).toBe(false)
    // PROGRESSIVE OPENING: the manifest is the eager layer, so its body is inline.
    expect(pkg.manifest.content).toContain("Analytics manifest")
    expect(pkg.how).toMatch(/use\(\{context, instruction\}\)/)
  })

  it("returns pinned skills as POINTERS, and says which pins have gone stale", async () => {
    // A skill the manifest pins at v1...
    const made = makeAuthedApp("cxr-pins", [owner, dev], "editor")
    const { app } = made
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(dev.email) })
    const skill = await (
      await publishAs(app, "# How to analyse", { title: "Analysis skill" }, as(dev.email))
    ).json()

    const answering = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Analyst" }))
    ).json()
    const ownerBot = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "OwnerBot" }))
    ).json()
    const manifest = await (
      await publishAs(
        app,
        `---\nskills:\n  - id: ${skill.short_id}\n    version: 1\n---\n# Analytics\n\nBody.`,
        { title: "Analytics manifest" },
        as(dev.email),
      )
    ).json()
    const cx = await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(dev.email), {
          name: "Analytics",
          agent_id: answering.id,
          manifest_short_id: manifest.short_id,
        }),
      )
    ).json()
    await app.request(`/v1/contexts/${cx.id}/askers`, jsonAs(as(dev.email), { email: owner.email }))

    const before = await call(app, ownerBot.token, "read", { short_id: cx.id })
    expect(before.skills).toHaveLength(1)
    expect(before.skills[0].short_id).toBe(skill.short_id)
    expect(before.skills[0].pinned_version).toBe(1)
    // A POINTER, not the body — following it is a separate read, which is the whole point.
    expect(before.skills[0]).not.toHaveProperty("content")
    expect(before.skills[0].stale).toBe(false)

    // ...now the skill moves to v2 while the pin still says v1. A run would execute v1, so
    // the read has to say so — the one thing a pinned-skill model gets silently wrong.
    await publishAs(app, "# How to analyse, revised", {}, as(dev.email), skill.short_id)
    const after = await call(app, ownerBot.token, "read", { short_id: cx.id })
    expect(after.skills[0].pinned_version).toBe(1)
    expect(after.skills[0].current_version).toBe(2)
    expect(after.skills[0].stale).toBe(true)
  })

  it("resolves a context by NAME, but never shadows an artifact of that name", async () => {
    const { app, ownerToken, invite } = await setup("cxr-name", "# Analytics manifest\n\nBody.")
    expect((await invite()).status).toBe(201)

    // By name: the package.
    const byName = await call(app, ownerToken, "read", { short_id: "Analytics" })
    expect(byName.context?.name).toBe("Analytics")

    // A DOCUMENT is still reached by its own short_id — the context branch only runs for a
    // ctx_ id, or as a fallback after the artifact lookup misses, so documents keep priority.
    const doc = await (
      await publishAs(app, "# A real document", { title: "Analytics" }, as(dev.email))
    ).json()
    // A document read comes back as a DOC response (text), not the package JSON — so the
    // absence of a context payload here is the assertion.
    const byShortId = await callRaw(app, ownerToken, "read", { short_id: doc.short_id })
    expect(byShortId.isError).toBe(false)
    expect(byShortId.text).toContain("A real document")
    expect(byShortId.text).not.toContain('"context"')
  })
})

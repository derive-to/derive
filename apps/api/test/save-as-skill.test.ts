import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// Save-as-skill: the capture pair. GET returns the copyable prompt; POST delivers the
// identical instruction (saveAsSkillInstruction is the single source) to a registered
// agent's pull inbox — the rework-route pattern. The captured skill publishes LIVE and
// gets reviewed by comments on the live version.

const owner: TestUser = {
  id: "u_cap_own",
  email: "capown@derive.test",
  name: "Owner",
  username: "capown",
}
const editor: TestUser = {
  id: "u_cap_ed",
  email: "caped@derive.test",
  name: "Ed",
  username: "caped",
}

const { app } = makeAuthedApp("skillcap", [owner, editor], "editor")

const addAgent = async (name: string) =>
  (await (
    await app.request("/v1/agents", jsonAs(as(owner.email), { name, role: "editor" }))
  ).json()) as { id: string; name: string; token: string }

const comment = async (shortId: string, body: string) =>
  (await (
    await app.request(
      `/v1/artifacts/${shortId}/comments`,
      jsonAs(as(owner.email), { body_md: body }),
    )
  ).json()) as { thread_id: string }

const getPrompt = (shortId: string, qs = "") =>
  app.request(`/v1/artifacts/${shortId}/save-as-skill${qs}`, { headers: as(editor.email) })
const post = (shortId: string, body: Record<string, unknown> = {}) =>
  app.request(`/v1/artifacts/${shortId}/save-as-skill`, jsonAs(as(editor.email), body))

describe("GET /save-as-skill — the copyable capture prompt", () => {
  it("carries the dedup step, the skill contract, the footer, the thread, and the note", async () => {
    const page = await (
      await publishAs(app, "<h1>Pricing</h1>", { title: "Pricing" }, as(owner.email))
    ).json()
    const thread = await comment(page.short_id, "we never show USD without EUR alongside")
    const res = await getPrompt(
      page.short_id,
      `?threadId=${thread.thread_id}&note=${encodeURIComponent("pricing pages only")}`,
    )
    expect(res.status).toBe(200)
    const { prompt } = (await res.json()) as { prompt: string }
    expect(prompt).toContain(page.short_id)
    expect(prompt).toContain(thread.thread_id)
    expect(prompt).toContain("derive://skills") // dedup: read the catalog first
    expect(prompt).toContain("SKILL.md")
    expect(prompt).toContain("leave a comment on this skill") // the deviation footer
    expect(prompt).toContain("live") // publishes live
    expect(prompt).toContain("From the requester: pricing pages only")
  })

  it("404s a thread that is not on this artifact", async () => {
    const a = await (await publishAs(app, "# A", {}, as(owner.email))).json()
    const b = await (await publishAs(app, "# B", {}, as(owner.email))).json()
    const elsewhere = await comment(b.short_id, "unrelated")
    const res = await getPrompt(a.short_id, `?threadId=${elsewhere.thread_id}`)
    expect(res.status).toBe(404)
  })
})

describe("POST /save-as-skill — the one-click ask", () => {
  it("lands the instruction in the agent's inbox, once per artifact", async () => {
    const page = await (
      await publishAs(app, "<h1>Report</h1>", { title: "Report" }, as(owner.email))
    ).json()
    const agent = await addAgent("Capturer")
    const res = await post(page.short_id, { note: "the summary-table rule" })
    expect(res.status).toBe(201)

    const inbox = (await (
      await app.request("/v1/agent/inbox", { headers: bearer(agent.token) })
    ).json()) as { mentions: { body: string }[] }
    const body = inbox.mentions[0]?.body ?? ""
    expect(body).toContain(page.short_id)
    expect(body).toContain("derive://skills")
    expect(body).toContain("From the requester: the summary-table rule")

    const again = await post(page.short_id)
    expect(again.status).toBe(409)
    expect(((await again.json()) as { code: string }).code).toBe("alreadyQueued")
  })

  it("409s needsAgent when no agent is registered", async () => {
    const lone = makeAuthedApp("skillcap-noagent", [owner, editor], "editor")
    const page = await (await publishAs(lone.app, "# Doc", {}, as(owner.email))).json()
    const res = await lone.app.request(
      `/v1/artifacts/${page.short_id}/save-as-skill`,
      jsonAs(as(editor.email), {}),
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe("needsAgent")
  })
})

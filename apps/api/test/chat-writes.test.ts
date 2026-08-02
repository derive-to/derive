import { describe, expect, it } from "vitest"
import {
  buildChatTools,
  CHAT_TOOLS,
  CHAT_USE_WAIT_S,
  chatPolicy,
  RAIL_CHAT_TOOLS,
} from "../src/lib/chat-tools"
import { as, makeAuthedApp, publishAs } from "./helpers"

// WRITING FROM CHAT. The posture is applied to the ARGUMENTS, after the model has spoken, which
// is the whole reason it holds: an instruction in a prompt can be argued with by a document the
// turn just read, and this cannot.

describe("the chat write posture", () => {
  it("creates live and edits as a proposal", () => {
    // No short_id ⇒ a create. Nothing is being replaced, so nothing needs reviewing first.
    expect(chatPolicy("publish", { title: "New", content: "x" })).not.toHaveProperty("for_review")
    // A short_id ⇒ an EDIT of work somebody already has. That lands as a proposal.
    expect(chatPolicy("publish", { short_id: "ab12cd34", content: "x" })).toMatchObject({
      for_review: true,
    })
  })

  it("cannot be talked out of it — the posture is not in the prompt", () => {
    // The shape a prompt injection produces: the model asks, explicitly, to publish live.
    expect(
      chatPolicy("publish", { short_id: "ab12cd34", content: "x", for_review: false }),
    ).toMatchObject({ for_review: true })
  })

  it("only ever tightens: it never turns a proposal into a live publish", () => {
    expect(chatPolicy("publish", { title: "New", for_review: true })).toMatchObject({
      for_review: true,
    })
  })

  it("honours the KILLSWITCH on creates, not only on edits", () => {
    // The switch is documented as "demotes EVERY write to a proposal, instantly", and it is an
    // input to the autonomy GATE — which a chat write never reaches, because it goes through
    // the publish tool. Without this it stopped every gated lane and left chat creating live.
    expect(chatPolicy("publish", { title: "New" }, { agentKillswitch: true })).toMatchObject({
      for_review: true,
    })
    // ...and with it off, creating stays live.
    expect(chatPolicy("publish", { title: "New" }, { agentKillswitch: false })).not.toHaveProperty(
      "for_review",
    )
  })

  it("caps how long a chat turn waits on a packaged agent", () => {
    // A Maker context can work for minutes and the person is sitting there, so the turn relays
    // a pointer rather than holding the conversation open.
    expect(chatPolicy("use", { context: "c", instruction: "go", wait: 300 })).toMatchObject({
      wait: CHAT_USE_WAIT_S,
    })
    // A shorter ask is honored — the cap is a ceiling, not a floor.
    expect(chatPolicy("use", { context: "c", wait: 2 })).toMatchObject({ wait: 2 })
    // Absent ⇒ the cap, so a turn never blocks indefinitely by omission.
    expect(chatPolicy("use", { context: "c" })).toMatchObject({ wait: CHAT_USE_WAIT_S })
    // A negative is the model's mistake; clamping beats spending a turn on a tool error.
    expect(chatPolicy("use", { context: "c", wait: -5 })).toMatchObject({ wait: 0 })
  })

  it("leaves the reading tools alone", () => {
    const args = { query: "roadmap" }
    expect(chatPolicy("find", args)).toBe(args)
    expect(chatPolicy("read", { short_id: "x" })).toMatchObject({ short_id: "x" })
  })
})

describe("which tools each chat surface holds", () => {
  it("the workspace chat can write; the document rail cannot", () => {
    expect([...CHAT_TOOLS].sort()).toEqual(["call", "find", "publish", "read", "use"])
    // The rail keeps ONE writer — its own revision contract + landing port. A publish tool
    // beside that would be a second write path for the same document, deciding differently.
    expect([...RAIL_CHAT_TOOLS].sort()).toEqual(["find", "read"])
  })

  it("the rail's surface really is narrower — the write tool has no handler there", async () => {
    const { ctx } = makeAuthedApp("rail-subset", [{ id: "u1", email: "u1@x.com", name: "U" }])
    const rail = buildChatTools(
      ctx,
      { org: "default", user: { id: "u1", name: "U" }, seatRole: "owner" },
      RAIL_CHAT_TOOLS,
    )
    expect(rail.tools.map((t) => t.name).sort()).toEqual(["find", "read"])
    const out = (await rail.execute("publish", { title: "x", content: "y" })) as { error?: string }
    expect(out.error).toMatch(/unknown tool/i)
  })

  it("a write tool carries its own skills into the index", async () => {
    const { ctx } = makeAuthedApp("ws-subset", [{ id: "u1", email: "u1@x.com", name: "U" }])
    const ws = buildChatTools(ctx, {
      org: "default",
      user: { id: "u1", name: "U" },
      seatRole: "owner",
    })
    const names = ws.skills.map((s) => s.name)
    // publish brings publishing + assets; use brings contexts; find/read bring finding.
    expect(names).toContain("finding")
    expect(names).toContain("publishing")
    expect(names).toContain("contexts")
  })
})

describe("writing through the real publish tool", () => {
  it("creates an artifact attributed to the ASKER, not to Derive", async () => {
    const users = [{ id: "u-w", email: "w@x.com", name: "Writer" }]
    const { app, ctx, meta } = makeAuthedApp("chat-write", users)
    await app.request("/v1/me", { headers: as("w@x.com") })
    const tools = buildChatTools(ctx, {
      org: "default",
      user: { id: "u-w", name: "Writer" },
      seatRole: "owner",
    })
    // The tool answers with a JSON document as TEXT (that is what `json()` produces on this
    // surface), so read it the way a model would rather than regexing the escaped form.
    const raw = await tools.execute("publish", { title: "From chat", content: "# Hello" })
    const out = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as {
      published?: boolean
      short_id?: string
      version?: number
    }
    expect(out.published).toBe(true)
    expect(out.version).toBe(1)
    const shortId = out.short_id
    expect(shortId).toBeTruthy()
    const art = await meta.getByShortId(shortId ?? "")
    // Live, because creating replaces nothing...
    expect(art?.current_version).toBe(1)
    // ...and it belongs to the person who asked for it, which is what makes chat's writes
    // indistinguishable downstream from any other write they make.
    const versions = await meta.listVersions(art?.id ?? "")
    expect(versions[0]?.author_id).toBe("u-w")
  })

  it("an EDIT files a proposal instead of a version", async () => {
    const users = [{ id: "u-w", email: "w@x.com", name: "Writer" }]
    const { app, ctx, meta } = makeAuthedApp("chat-edit", users)
    const doc = (await (
      await publishAs(app, "# Original", { title: "Doc" }, as("w@x.com"))
    ).json()) as { short_id: string }
    const tools = buildChatTools(ctx, {
      org: "default",
      user: { id: "u-w", name: "Writer" },
      seatRole: "owner",
    })
    await tools.execute("publish", { short_id: doc.short_id, content: "# Rewritten" })
    const art = await meta.getByShortId(doc.short_id)
    expect(art?.current_version).toBe(1) // untouched
    expect(await meta.listProposals(art?.id ?? "")).toHaveLength(1)
  })
})

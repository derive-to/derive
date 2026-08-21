import { DEFAULT_ORG_SETTINGS } from "@derive/core"
import { describe, expect, it } from "vitest"
import { boundSources } from "../src/lib/chat-sources"
import {
  buildChatTools,
  CHAT_TOOLS,
  CHAT_USE_WAIT_S,
  chatPolicy,
  RAIL_CHAT_TOOLS,
} from "../src/lib/chat-tools"
import { as, makeAuthedApp, publishAs } from "./helpers"

// THE CHAT PRINCIPAL. These are the tests that matter most in this feature: the chat turn runs
// Derive's REAL MCP tool handlers, so what stops it doing something the asker could not do by
// hand is the principal it is constructed with, and nothing else. Each case below is one
// property of that principal, asserted through a real tool call rather than by reading the
// construction back.

describe("the chat tool surface", () => {
  it("offers exactly the chat subset — not the whole MCP surface", async () => {
    const { ctx } = makeAuthedApp("ct-subset", [{ id: "u1", email: "u1@x.com", name: "U" }])
    const tools = buildChatTools(ctx, {
      org: "default",
      user: { id: "u1", name: "U" },
      seatRole: "owner",
    })
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...CHAT_TOOLS].sort())
    // Each tool reaches the model with its real description and a projected JSON schema — a
    // tool the model cannot be told about correctly is a tool it will call wrongly.
    for (const t of tools.tools) {
      expect(t.description.length).toBeGreaterThan(20)
      expect(t.params).toMatchObject({ type: "object" })
    }
  })

  it("the SWITCH refuses the publish tool outright — the draft goes in the reply", async () => {
    // The one brake, reaching chat: with agent writes off, nothing lands live from a chat
    // turn. The refusal is data the model reads (steering it to surface the change as
    // text), not an exception that costs the turn.
    const { ctx } = makeAuthedApp("ct-kill", [{ id: "u1", email: "u1@x.com", name: "U" }])
    const tools = buildChatTools(ctx, {
      org: "default",
      user: { id: "u1", name: "U" },
      seatRole: "owner",
      flags: { agentWrites: false },
    })
    const out = (await tools.execute("publish", { title: "New", content: "# x" })) as {
      error?: string
    }
    expect(out.error).toMatch(/agent writes switched off/i)
    expect(out.error).toMatch(/suggestion|reply/i)
  })

  it("an omitted tool has no handler at all, rather than a guard that could be skipped", async () => {
    const { ctx } = makeAuthedApp("ct-omit", [{ id: "u1", email: "u1@x.com", name: "U" }])
    const tools = buildChatTools(ctx, {
      org: "default",
      user: { id: "u1", name: "U" },
      seatRole: "owner",
    })
    // `stage` is out of the chat subset (an out-of-band upload workflow for a shell), so there
    // is nothing to call — not a handler that checks whether it is allowed and declines.
    const out = (await tools.execute("stage", { target: "doc" })) as { error?: string }
    expect(out.error).toMatch(/unknown tool/i)
  })

  it("cannot reach another workspace's artifact, even one the tool could otherwise roam to", async () => {
    // Two workspaces, one person in each. `isolated` means nobody shares a seat.
    const alice = { id: "u-al", email: "al@x.com", name: "Al" }
    const bob = { id: "u-bo", email: "bo@x.com", name: "Bo" }
    const { app, ctx, meta } = makeAuthedApp("ct-tenant", [alice, bob], undefined, {
      isolated: true,
    })
    await app.request("/v1/me", { headers: as(alice.email) })
    await app.request("/v1/me", { headers: as(bob.email) })
    const secret = await (
      await publishAs(app, "# Bob's plan", { title: "Bobs plan" }, as(bob.email))
    ).json()
    const bobsOrg = (await meta.getByShortId(secret.short_id))?.org_id ?? ""
    const alicesOrg = (await meta.listWorkspaces(alice.id))[0]?.id ?? ""
    expect(bobsOrg).not.toBe(alicesOrg)

    // Alice's chat, clamped to Alice's workspace, naming Bob's document explicitly.
    const tools = buildChatTools(ctx, {
      org: alicesOrg,
      user: { id: alice.id, name: "Al" },
      seatRole: "owner",
    })
    const out = JSON.stringify(await tools.execute("read", { short_id: secret.short_id }))
    expect(out).not.toContain("Bob's plan")
    expect(out).toMatch(/no artifact|not found|cannot|reach/i)
  })

  it("acts at the ASKER's seat: a viewer's chat cannot see what a viewer cannot see", async () => {
    const owner = { id: "u-ow", email: "ow@x.com", name: "Ow" }
    const viewer = { id: "u-vi", email: "vi@x.com", name: "Vi" }
    // The whole workspace at `viewer` grade — the seat is the ceiling, and the tool enforces it.
    const { app, ctx, meta: metaOf } = makeAuthedApp("ct-seat", [owner, viewer], "viewer")
    await app.request("/v1/me", { headers: as(viewer.email) })
    const doc = await (
      await publishAs(app, "# Private planning", { title: "Planning" }, as(owner.email))
    ).json()

    const asOwner = buildChatTools(ctx, {
      org: "default",
      user: { id: owner.id, name: "Ow" },
      seatRole: "owner",
    })
    expect(JSON.stringify(await asOwner.execute("read", { short_id: doc.short_id }))).toContain(
      "Private planning",
    )
    // Same tool, same document, a lower seat — and the difference is the principal, not a
    // chat-specific check.
    const asViewer = buildChatTools(ctx, {
      org: "default",
      user: { id: viewer.id, name: "Vi" },
      seatRole: "viewer",
    })
    const out = await asViewer.execute("read", { short_id: doc.short_id })
    expect(JSON.stringify(out)).toContain("Private planning") // a viewer CAN read

    // ...and where the seat REALLY shows is the write. The viewer holds the same publish tool
    // the owner does — the subset is per-surface, not per-person — and the TOOL refuses them,
    // which is the whole point of running the asker's own principal instead of a chat-specific
    // permission check that could disagree with it.
    expect(asViewer.tools.some((t) => t.name === "publish")).toBe(true)
    const before = (await metaOf.getByShortId(doc.short_id))?.current_version
    await asViewer.execute("publish", {
      short_id: doc.short_id,
      content: "# Rewritten by a viewer",
    })
    expect((await metaOf.getByShortId(doc.short_id))?.current_version).toBe(before)
  })

  it("has no agent inbox: a chat principal is not an @mentionable identity", async () => {
    const { ctx } = makeAuthedApp("ct-inbox", [{ id: "u1", email: "u1@x.com", name: "U" }])
    const tools = buildChatTools(
      ctx,
      { org: "default", user: { id: "u1", name: "U" }, seatRole: "owner" },
      new Set(["catch_up"]),
    )
    // Reached only by explicitly widening the subset in this test: with no short_id, catch_up
    // is the work QUEUE, and a chat principal must report that it has none rather than
    // returning an empty list that reads as "no work waiting".
    const out = JSON.stringify(await tools.execute("catch_up", {}))
    expect(out).toMatch(/no inbox/i)
  })
})

describe("which surfaces hold call", () => {
  // WHO GETS `call`, and who deliberately does not.
  //
  // The registry is shared: the chat surface and external MCP clients register from the same
  // place. The gate there (`wanted`) is true whenever no explicit set is passed, which is
  // exactly how an external client registers — so the ordinary registration form would hand
  // `call` to every client holding a grant. What it reaches is the WORKSPACE's connected
  // credentials, and an external client already holds its own.
  //
  // `call` is therefore opt-in: registered only when a surface NAMES it. These tests pin both
  // halves of that, because the plumbing silently undoing the decision is the failure mode.

  it("the workspace chat holds it", () => {
    expect(CHAT_TOOLS.has("call")).toBe(true)
  })

  it("the document rail does NOT — it is a read-only lane about one document", () => {
    expect(RAIL_CHAT_TOOLS.has("call")).toBe(false)
    expect([...RAIL_CHAT_TOOLS].sort()).toEqual(["find", "read"])
  })
})

describe("chat source binding", () => {
  // WHICH CONNECTIONS A CONVERSATION MAY REACH.
  //
  // A packaged run declares its own connections, so a Stripe-bound run sees Stripe and nothing
  // else. A conversation declares nothing — somebody types a sentence — so this list is the
  // missing declaration, made by whoever owns the credential rather than whoever is typing.

  it("is EMPTY by default, so connecting a server never widens chat on its own", () => {
    // The whole safety property of the feature. An admin connecting Stripe for automations
    // must not thereby hand every chat turn in the workspace a payments API.
    expect(DEFAULT_ORG_SETTINGS.chatSources).toEqual([])
  })

  it("is separate from chatBeta — being able to chat is not being able to reach a source", () => {
    expect(DEFAULT_ORG_SETTINGS.chatBeta).toBe(true)
    expect(DEFAULT_ORG_SETTINGS.chatSources).toHaveLength(0)
  })
})

describe("which declared sources a person reaches", () => {
  // WHO REACHES WHICH SOURCE. The declaration says WHETHER a connection is exposed to chat at
  // all; the connection's SCOPE says whose chat. Declaring a personal connection must not lend
  // one person's credential to the whole team — and the borrower would never know whose account
  // answered, which is what makes that failure worse than a refusal.

  const store = (conns: { id: string; user_id: string; scope: string }[], declared: string[]) =>
    ({
      getOrgSettings: async () => ({ chatSources: declared }),
      listConnections: async () =>
        conns.map((c) => ({ ...c, toolkit: `tk-${c.id}`, kind: "mcp", org_id: "o" })),
    }) as never

  const ALICE = "u-alice"
  const BOB = "u-bob"

  it("a WORKSPACE source reaches everyone", async () => {
    const meta = store([{ id: "c1", user_id: ALICE, scope: "workspace" }], ["c1"])
    expect((await boundSources(meta, "o", BOB)).map((s) => s.id)).toEqual(["c1"])
  })

  it("a PERSONAL source reaches only its owner, even when declared", async () => {
    // The leak this prevents: Alice connects her own Stripe, an admin declares it for chat,
    // and Bob's turn spends Alice's credential.
    const meta = store([{ id: "c1", user_id: ALICE, scope: "personal" }], ["c1"])
    expect((await boundSources(meta, "o", ALICE)).map((s) => s.id)).toEqual(["c1"])
    expect(await boundSources(meta, "o", BOB)).toEqual([])
  })

  it("an UNDECLARED source reaches nobody, whatever its scope or owner", async () => {
    const meta = store([{ id: "c1", user_id: BOB, scope: "workspace" }], [])
    expect(await boundSources(meta, "o", BOB)).toEqual([])
  })

  it("reaches nothing when there is no asker at all", async () => {
    // Belt and braces on the membership gate: chat already refuses a non-member before this
    // runs, but a null asker must never widen into "personal sources for everyone".
    const meta = store([{ id: "c1", user_id: ALICE, scope: "personal" }], ["c1"])
    expect(await boundSources(meta, "o", null)).toEqual([])
  })
})

describe("writing from chat", () => {
  // WRITING FROM CHAT. The posture is applied to the ARGUMENTS, after the model has spoken, which
  // is the whole reason it holds: an instruction in a prompt can be argued with by a document the
  // turn just read, and this cannot.

  describe("the chat write posture", () => {
    it("creates live and edits with a review round asked", () => {
      // No short_id ⇒ a create. Nothing is being replaced, so nothing needs a look first.
      expect(chatPolicy("publish", { title: "New", content: "x" })).not.toHaveProperty(
        "request_review",
      )
      // A short_id ⇒ an EDIT of work somebody already has. It publishes live and asks the
      // person to look — the note is one glance, and restore is one click.
      expect(chatPolicy("publish", { short_id: "ab12cd34", content: "x" })).toMatchObject({
        request_review: true,
      })
    })

    it("cannot be talked out of it — the posture is not in the prompt", () => {
      // The shape a prompt injection produces: the model asks, explicitly, to skip the review.
      expect(
        chatPolicy("publish", { short_id: "ab12cd34", content: "x", request_review: false }),
      ).toMatchObject({ request_review: true })
    })

    it("only ever tightens: it never drops a review the model asked for", () => {
      expect(chatPolicy("publish", { title: "New", request_review: true })).toMatchObject({
        request_review: true,
      })
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
  })

  describe("which tools each chat surface holds", () => {
    it("the rail's surface really is narrower — the write tool has no handler there", async () => {
      const { ctx } = makeAuthedApp("rail-subset", [{ id: "u1", email: "u1@x.com", name: "U" }])
      const rail = buildChatTools(
        ctx,
        { org: "default", user: { id: "u1", name: "U" }, seatRole: "owner" },
        RAIL_CHAT_TOOLS,
      )
      expect(rail.tools.map((t) => t.name).sort()).toEqual(["find", "read"])
      const out = (await rail.execute("publish", { title: "x", content: "y" })) as {
        error?: string
      }
      expect(out.error).toMatch(/unknown tool/i)
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

    it("an EDIT publishes live and opens a review round", async () => {
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
      // The edit lands as a version — and the posture asked the person to look at it.
      expect(art?.current_version).toBe(2)
      const round = await meta.getPendingRound(art?.id ?? "")
      expect(round?.version).toBe(2)
      // The round is the RECORD of the person's own conversational edit, never an interrupt
      // at them: no review email is enqueued for the asker about their own ask.
      const far = new Date(Date.now() + 10_000_000).toISOString()
      const due = await meta.claimDueDeliveries(far, 50, far)
      expect(due.filter((d) => d.kind === "email" && d.event_type === "review.requested")).toEqual(
        [],
      )
    })
  })
})

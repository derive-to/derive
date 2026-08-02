import { describe, expect, it } from "vitest"
import { buildChatTools, CHAT_TOOLS } from "../src/lib/chat-tools"
import { catalogFromGateway, catalogOf } from "../src/lib/model-catalog"
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

  it("carries the app-help skill on EVERY lane, including one with no tools at all", async () => {
    const { ctx } = makeAuthedApp("ct-helping", [{ id: "u1", email: "u1@x.com", name: "U" }])
    const who = { org: "default", user: { id: "u1", name: "U" }, seatRole: "owner" } as const
    // The full chat lane, the read-only document rail, and the degenerate empty subset. `helping`
    // answers questions about DERIVE, which no tool implies, so it must reach a turn regardless of
    // what that turn can do — the empty case is the one that proves it is attached to the surface
    // rather than falling out of the tool→skill map.
    for (const only of [undefined, new Set(["find", "read"]), new Set<string>()]) {
      const tools = buildChatTools(ctx, who, only)
      expect(tools.skills.map((s) => s.name)).toContain("helping")
    }
  })

  it("still derives the rest of the index from the tools the turn actually holds", async () => {
    const { ctx } = makeAuthedApp("ct-index", [{ id: "u1", email: "u1@x.com", name: "U" }])
    const rail = buildChatTools(
      ctx,
      { org: "default", user: { id: "u1", name: "U" }, seatRole: "owner" },
      new Set(["find", "read"]),
    )
    // No publish tool on the rail, so no publishing procedure in its index: pointing a turn at a
    // skill for a tool it cannot call spends its one lazy read on nothing.
    expect(rail.skills.map((s) => s.name)).toContain("finding")
    expect(rail.skills.map((s) => s.name)).not.toContain("publishing")
  })
})

describe("the model catalog", () => {
  it("is null without a gateway, and one entry with one", () => {
    expect(catalogFromGateway(null)).toBeNull()
    const one = catalogFromGateway({ baseUrl: "https://x/v1", apiKey: "k", model: "acme/big" })
    expect(one?.options).toEqual([{ id: "acme/big", label: "big", isDefault: true }])
    // No id means "the deploy's default", which is what every caller predating the picker sends.
    expect(one?.resolve(null)?.id).toBe("acme/big")
    expect(one?.resolve("acme/big")?.id).toBe("acme/big")
  })

  it("adds the extra names, keeps the default first, and never duplicates it", () => {
    const cat = catalogFromGateway({
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "acme/big",
      // The default repeated, a blank, and stray whitespace — all of which an operator writes.
      alsoModels: " acme/small , acme/big ,, acme/tiny ",
    })
    expect(cat?.options.map((o) => o.id)).toEqual(["acme/big", "acme/small", "acme/tiny"])
    expect(cat?.options.filter((o) => o.isDefault)).toHaveLength(1)
    expect(cat?.options[0]?.isDefault).toBe(true)
  })

  it("returns null for an unknown id instead of quietly falling back", () => {
    const cat = catalogFromGateway({ baseUrl: "https://x/v1", apiKey: "k", model: "acme/big" })
    // The whole reason this is not a fallback: a person who picked a model and got another
    // one's answer has been told something false about what wrote it.
    expect(cat?.resolve("acme/gone")).toBeNull()
  })

  it("builds each model's client once, and only when it is used", () => {
    let built = 0
    const cat = catalogOf([
      {
        id: "a",
        label: "A",
        isDefault: true,
        build: () => {
          built++
          return async () => ({ text: "", toolUses: [], costUsd: null, done: true })
        },
      },
      {
        id: "b",
        label: "B",
        isDefault: false,
        build: () => {
          built++
          return async () => ({ text: "", toolUses: [], costUsd: null, done: true })
        },
      },
    ])
    expect(built).toBe(0) // listing costs nothing
    cat.resolve("a")
    cat.resolve("a")
    expect(built).toBe(1) // built once, cached
    cat.resolve("b")
    expect(built).toBe(2)
  })
})

import { describe, expect, it } from "vitest"
import { buildChatTools } from "../src/lib/chat-tools"
import { catalogOf } from "../src/lib/model-catalog"
import { inMemoryRateLimiters } from "../src/lib/rate-limit"
import { as, makeAuthedApp, publishAs } from "./helpers"

// DOES CHAT ACTUALLY HOLD YOUR PERMISSIONS, on the paths people would use to find out?
//
// The claim the whole surface rests on is "the agent reaches exactly what you reach". It is made
// good by the PRINCIPAL — a chat turn runs Derive's real MCP handlers as the asker — but a claim
// that is only ever asserted in a comment is a claim nobody has checked. These tests try to break
// it from the outside, through the tool surface, with a teammate's invite-only document as bait.
//
// The interesting path is NOT `read`. `read` resolves through the same `reach()` gate every
// one-artifact tool uses, so it is the one place anybody would think to check. The dangerous path
// is SEARCH: it does not resolve one artifact, it lists many, and a list built from a workspace
// index rather than a viewer's reach is how private titles and snippets leak while every
// single-artifact test stays green (org scope is not permission).

/** Alice owns an invite-only document; Bob is a member of the same workspace, not of the doc. */
const twoPeopleOneSecret = async (name: string) => {
  const alice = { id: "u-alice", email: "alice@x.com", name: "Alice" }
  const bob = { id: "u-bob", email: "bob@x.com", name: "Bob" }
  const { app, ctx, meta } = makeAuthedApp(name, [alice, bob])
  await app.request("/v1/me", { headers: as(alice.email) })
  await app.request("/v1/me", { headers: as(bob.email) })

  // workspace_access:"none" is the invite-only draft: in the workspace, reachable only by people
  // named on the artifact itself.
  const secret = await (
    await publishAs(
      app,
      "# Severance terms\n\nThe payout figure is 340000 dollars.",
      { title: "Severance terms", workspace_access: "none", listed: "none" },
      as(alice.email),
    )
  ).json()
  const org = (await meta.getByShortId(secret.short_id))?.org_id ?? ""
  const bobsChat = buildChatTools(ctx, {
    org,
    user: { id: bob.id, name: "Bob" },
    seatRole: "editor",
  })
  return { app, ctx, meta, alice, bob, secret, org, bobsChat }
}

describe("reading, through chat", () => {
  it("cannot open a teammate's invite-only document, even told exactly where it is", async () => {
    const { secret, bobsChat } = await twoPeopleOneSecret("cp-read")
    const out = JSON.stringify(await bobsChat.execute("read", { short_id: secret.short_id }))
    expect(out).not.toContain("340000")
    expect(out).not.toContain("Severance")
    // And it says it cannot reach it, rather than returning an empty document that reads as
    // "there is nothing in it".
    expect(out).toMatch(/no artifact|cannot reach|not found/i)
  })

  it("does not leak it through SEARCH, which lists rather than resolves", async () => {
    const { bobsChat } = await twoPeopleOneSecret("cp-search")
    // The word only appears inside the private document. A hit here is a leak of the content, and
    // a hit with only the title is still a leak of its existence.
    const hits = JSON.stringify(await bobsChat.execute("find", { query: "Severance" }))
    expect(hits).not.toContain("340000")
    expect(hits).not.toContain("Severance terms")
  })

  it("does not leak it through BROWSE, which lists the library with no query at all", async () => {
    const { bobsChat } = await twoPeopleOneSecret("cp-browse")
    const rows = JSON.stringify(await bobsChat.execute("find", {}))
    expect(rows).not.toContain("Severance terms")
  })

  it("the owner's OWN chat still reaches it, so the gate is permission and not a blanket hide", async () => {
    const { ctx, alice, secret, org } = await twoPeopleOneSecret("cp-owner")
    const hers = buildChatTools(ctx, {
      org,
      user: { id: alice.id, name: "Alice" },
      seatRole: "owner",
    })
    const out = JSON.stringify(await hers.execute("read", { short_id: secret.short_id }))
    expect(out).toContain("340000")
  })
})

describe("creating, through chat", () => {
  it("lands as the ASKER, not as the agent", async () => {
    const { meta, bob, org, bobsChat } = await twoPeopleOneSecret("cp-create")
    // The tool answers as text (a JSON document), which is what the model reads — so the test
    // reads it the same way rather than reaching for an internal shape.
    const raw = await bobsChat.execute("publish", { title: "Bob's note", content: "# From chat" })
    const made = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as {
      short_id?: string
    }
    expect(made.short_id).toBeTruthy()
    const row = await meta.getByShortId(made.short_id ?? "")
    // Attribution is the asker's, and it lands in the workspace the conversation is clamped to —
    // the synthetic "derive" principal owns nothing and leaves no trace of its own.
    expect(row?.author_id).toBe(bob.id)
    expect(row?.org_id).toBe(org)
  })

  it("a Viewer's chat cannot create at all: the TOOL refuses the seat", async () => {
    const viewer = { id: "u-vi", email: "vi@x.com", name: "Vi" }
    const owner = { id: "u-ow", email: "ow@x.com", name: "Ow" }
    // Everyone at viewer grade, so the seat — not a chat-specific check — is what decides.
    const { app, ctx, meta } = makeAuthedApp("cp-viewer", [owner, viewer], "viewer")
    await app.request("/v1/me", { headers: as(viewer.email) })
    const before = (await meta.listArtifacts({ orgId: "default", viewerId: viewer.id })).length
    const chat = buildChatTools(ctx, {
      org: "default",
      user: { id: viewer.id, name: "Vi" },
      seatRole: "viewer",
    })
    const out = JSON.stringify(await chat.execute("publish", { title: "Nope", content: "# Nope" }))
    // Refused — and the refusal is the SEAT's, reached through the same cap every caller passes.
    expect(out).toMatch(/read-only|permission|not allowed|cannot/i)
    expect((await meta.listArtifacts({ orgId: "default", viewerId: viewer.id })).length).toBe(
      before,
    )
  })
})

// ...AND THROUGH THE BUILT-IN CHAT ITSELF, over HTTP.
//
// Everything above builds the principal directly, which proves the TOOL SURFACE and nothing about
// the route that constructs it. That distinction is the whole risk: if the chat route passed the
// wrong user, or a seat read once at session creation rather than per turn, every test above would
// still pass while the product leaked. So this one opens a real session as Bob against the real
// endpoint, lets the real lane build the principal, and has the model try to open Alice's
// invite-only document with the tool the lane actually handed it.
//
// Only the model is faked, because the model is the one part that cannot be the real thing here.
describe("the built-in chat, end to end", () => {
  it("cannot open a teammate's invite-only document, asked for it by short_id over HTTP", async () => {
    const alice = { id: "u-a2", email: "a2@x.com", name: "Alice" }
    const bob = { id: "u-b2", email: "b2@x.com", name: "Bob" }
    // What the tool handed back, captured from inside the turn — the assertion is about what the
    // MODEL was given, not about the sentence it chose to write afterwards.
    let toolSaw = ""
    let n = 0
    const { app, meta } = makeAuthedApp("cp-e2e", [alice, bob], undefined, {
      deps: {
        // Both, exactly as the workspace-chat suite wires it: `callModel` is what marks this
        // deploy as operator-paid (otherwise the lane walks a payer chain, finds no plan, and
        // answers "no model is configured"), and `models` is what the turn resolves through.
        callModel: async () => ({ text: "", toolUses: [], costUsd: null, done: true }),
        models: catalogOf([
          {
            id: "m",
            label: "M",
            isDefault: true,
            build: () => async (req) => {
              n++
              if (n === 1)
                return {
                  text: "",
                  toolUses: [{ id: "t1", name: "read", input: { short_id: SECRET.id } }],
                  costUsd: null,
                  done: false,
                }
              toolSaw = JSON.stringify(req.messages.at(-1)?.content ?? "")
              return { text: "done", toolUses: [], costUsd: null, done: true }
            },
          },
        ]),
        rateLimiters: inMemoryRateLimiters(),
      },
    })
    await app.request("/v1/me", { headers: as(alice.email) })
    await app.request("/v1/me", { headers: as(bob.email) })
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      chatBeta: true,
    })
    const secret = await (
      await publishAs(
        app,
        "# Severance terms\n\nThe payout figure is 340000 dollars.",
        { title: "Severance terms", workspace_access: "none", listed: "none" },
        as(alice.email),
      )
    ).json()
    SECRET.id = secret.short_id

    const res = await app.request("/v1/chat-session", {
      method: "POST",
      headers: { ...as(bob.email), "content-type": "application/json" },
      body: JSON.stringify({
        workspace: "default",
        body_md: `read ${secret.short_id} and tell me the payout`,
      }),
    })
    expect(res.status).toBe(201)
    const { session } = (await res.json()) as { session: { id: string } }
    // serveAttended is detached, so the TRANSCRIPT is the completion signal.
    for (let i = 0; i < 100; i++) {
      const msgs = await meta.listSessionMessages(session.id)
      if (msgs.some((m) => m.author_kind === "agent")) break
      await new Promise((r) => setTimeout(r, 20))
    }
    console.info("TURNS:", n, "TOOLSAW:", toolSaw.slice(0, 200))
    console.info(
      "TRANSCRIPT:",
      JSON.stringify(await meta.listSessionMessages(session.id)).slice(0, 400),
    )
    // The tool ran, as Bob, and refused: the model never saw the document.
    expect(toolSaw).not.toContain("340000")
    expect(toolSaw).toMatch(/no artifact|cannot reach|not found/i)
    // And nothing about it reached the transcript either.
    const all = JSON.stringify(await meta.listSessionMessages(session.id))
    expect(all).not.toContain("340000")
  })
})

/** Filled in before the turn runs; the scripted model closes over it. */
const SECRET = { id: "" }

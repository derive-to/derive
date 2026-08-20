import { describe, expect, it } from "vitest"
import { AGENT_SKILL_MD } from "../src/agent-skill.gen"
import { badChoice, choiceDescription } from "../src/lib/open-choice"
import { CORE_SKILLS } from "../src/skills-reference.gen"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// SURFACE COHERENCE — the failure this file exists to prevent: a client caches the tool
// schema at connect, so a capability shipped afterwards is unreachable (the client
// validates arguments locally and refuses before the request is sent) AND looks
// identical to a feature that was never built. Three defenses, tested here:
//   1. listChanged is advertised, so a compliant client knows to re-fetch.
//   2. Growth-prone discriminators are strings checked server-side, so a stale
//      client's new-value argument still ARRIVES and works.
//   3. list_workspaces reports the live tool surface, so staleness is diagnosable.

const owner: TestUser = { id: "u_sc", email: "sc@derive.test", name: "Owner" }
type App = ReturnType<typeof makeAuthedApp>["app"]

const rpc = async (app: App, token: string, method: string, params: object) => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const txt = await res.text()
  return (res.headers.get("content-type") ?? "").includes("application/json")
    ? JSON.parse(txt)
    : JSON.parse(
        (txt.split("\n").find((l) => l.startsWith("data:")) ?? "data:null").slice(5).trim(),
      )
}
const callTool = async (app: App, token: string, name: string, args: object) => {
  const out = await rpc(app, token, "tools/call", { name, arguments: args })
  const r = out?.result as { content?: { text: string }[]; isError?: boolean } | undefined
  return { text: r?.content?.[0]?.text ?? JSON.stringify(out), isError: !!r?.isError }
}

const setup = async (name: string) => {
  const { app } = makeAuthedApp(name, [owner], "editor")
  await app.request("/v1/me", { headers: as(owner.email) })
  const bot = await (
    await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Bot", role: "editor" }))
  ).json()
  return { app, token: bot.token as string }
}

describe("open-choice validation (pure)", () => {
  const VALUES = ["doc", "asset", "api"] as const

  it("accepts a valid value", () => {
    expect(badChoice("target", "api", VALUES)).toBeNull()
  })

  it("names the alternatives on an unknown value", () => {
    const msg = badChoice("target", "nope", VALUES)
    expect(msg).toContain("doc, asset, api")
  })

  it("calls out a near-miss as a near-miss (the likeliest hand-written failure)", () => {
    expect(badChoice("target", "API", VALUES)).toContain('must be exactly "api"')
    expect(badChoice("target", " doc ", VALUES)).toContain('must be exactly "doc"')
  })

  it("puts the values in the description, since the type no longer carries them", () => {
    expect(choiceDescription(VALUES, "What to stage.")).toBe(
      "What to stage. One of: doc, asset, api.",
    )
  })
})

describe("the surface a client sees", () => {
  it("advertises tools.listChanged so a compliant client re-fetches", async () => {
    const { app, token } = await setup("sc-listchanged")
    const out = await rpc(app, token, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    })
    expect(out?.result?.capabilities?.tools?.listChanged).toBe(true)
  })

  it("reports the LIVE tool list, so a stale cache is diagnosable", async () => {
    const { app, token } = await setup("sc-surface")
    const listed = await rpc(app, token, "tools/list", {})
    const advertised = (listed?.result?.tools ?? []).map((t: { name: string }) => t.name).sort()
    const out = JSON.parse((await callTool(app, token, "list_workspaces", {})).text)
    // What list_workspaces reports IS what the server actually serves — sourced from
    // the registry, so a tool added tomorrow can't drift out of this answer.
    expect(out.surface.tools).toEqual(advertised)
    expect(out.surface.tools).toContain("stage")
    expect(out.surface.note).toContain("reconnect")
  })
})

describe("a steer leads somewhere that covers the tool", () => {
  // The thin surface spends its brevity on a promise: each description states intent and
  // points at derive://skills/<name> for the procedure. The budget suite already proves
  // those URIs RESOLVE. It cannot see whether the destination says anything about the tool
  // that sent you there, and that gap shipped: `automate` steered to `loop`, whose body
  // contained the string "automate" zero times. An agent asked to schedule work read the
  // named skill, found nothing, read three more documents, and finally probed the API with
  // automate({action:"list"}) to learn the tool's own shape.
  //
  // A resolving link is not documentation. This asserts the other half.
  it("every skill a tool steers to mentions that tool", async () => {
    const { app, token } = await setup("sc-steer-covers")
    const listed = await rpc(app, token, "tools/list", {})
    const tools = (listed?.result?.tools ?? []) as { name: string; description?: string }[]
    const bodies = new Map(CORE_SKILLS.map((s) => [s.name, s.body]))

    const steers = tools.flatMap((t) =>
      [...(t.description ?? "").matchAll(/derive:\/\/skills\/([a-z]+)/g)].map((m) => ({
        tool: t.name,
        skill: m[1] as string,
      })),
    )
    // Guard the guard: if the steer convention is ever renamed, this must fail loudly
    // rather than pass by matching nothing.
    expect(steers.length).toBeGreaterThan(5)

    for (const { tool, skill } of steers) {
      const body = bodies.get(skill)
      expect(
        body,
        `${tool} steers to derive://skills/${skill}, which is not a core skill`,
      ).toBeTruthy()
      expect(
        body,
        `${tool} steers to derive://skills/${skill}, whose body never mentions ${tool} — the ` +
          `documented path leads somewhere that does not answer the question`,
      ).toContain(tool)
    }
  })
})

describe("the published skill agrees with the served surface", () => {
  // packages/cli/skills/derive/SKILL.md is the front door for an agent that has NOT connected:
  // it is served at /skill.md, shipped in the npm skill, and bundled in the Claude Code plugin.
  // It claimed a ten-tool surface while the server served twelve. `automate` landed 2026-07-25
  // and `clear_queue` 2026-08-10; the file was edited on 2026-08-17 and still said ten, because
  // sync-derive-agent-skill.mjs only diffs the copies against each other and would happily keep
  // three identical copies of a wrong list in sync.
  //
  // The list now lives between markers so it can be compared to the registry instead of read by
  // eye. registerToolSurface already captures the served names for exactly this reason.
  it("the tool list in SKILL.md is the tool list tools/list returns", async () => {
    const { app, token } = await setup("sc-skill-md")
    const listed = await rpc(app, token, "tools/list", {})
    const served = ((listed?.result?.tools ?? []) as { name: string }[]).map((t) => t.name).sort()

    const region = AGENT_SKILL_MD.match(/tools:start\s*-->([\s\S]*?)<!--\s*tools:end/)
    expect(region, "SKILL.md lost its <!-- tools:start --> region").toBeTruthy()
    const documented = [...(region?.[1] ?? "").matchAll(/`([a-z_]+)`/g)]
      .map((m) => m[1] as string)
      .sort()

    // Equality both ways on purpose: a tool that ships undocumented is the drift that
    // happened, and a tool documented after it was removed is the same bug pointing the
    // other way. The fixture registers the hosted shape — a tool that registers only when
    // a deploy configures something extra (a code sandbox, connected sources) is absent
    // here and absent from the skill, which is what this document should describe.
    expect(documented).toEqual(served)
  })
})

describe("a STALE client can still reach a newly-shipped capability", () => {
  // The regression that motivated all of this: `stage target:'api'` and
  // `automate action:'create_context'` both shipped as new enum VALUES, and every
  // already-connected client rejected them locally. As plain strings the argument
  // reaches the server, which is the only place that can know what's valid today.
  it("stage accepts a target its schema no longer enumerates", async () => {
    const { app, token } = await setup("sc-stale-stage")
    const listed = await rpc(app, token, "tools/list", {})
    const stage = (listed?.result?.tools ?? []).find((t: { name: string }) => t.name === "stage")
    // The schema must NOT pin the discriminator to a fixed set — that's what makes a
    // cached client refuse tomorrow's value.
    expect(stage.inputSchema.properties.target.enum).toBeUndefined()
    expect(stage.inputSchema.properties.target.type).toBe("string")
    // And a real call with the newest value is accepted (reaches the handler; it
    // refuses here only because a static agent token has no human to mint for).
    const out = await callTool(app, token, "stage", { target: "api" })
    expect(out.text).not.toContain("Invalid")
    expect(out.text).toContain("shell-usable bearer")
  })

  it("automate accepts an action its schema no longer enumerates", async () => {
    const { app, token } = await setup("sc-stale-automate")
    const listed = await rpc(app, token, "tools/list", {})
    const automate = (listed?.result?.tools ?? []).find(
      (t: { name: string }) => t.name === "automate",
    )
    expect(automate.inputSchema.properties.action.enum).toBeUndefined()
    expect(automate.inputSchema.properties.action.type).toBe("string")
  })

  it("still rejects a genuinely wrong value — with a better error than a type failure", async () => {
    const { app, token } = await setup("sc-wrong")
    const out = await callTool(app, token, "stage", { target: "nonsense" })
    expect(out.text).toContain("doc, asset, api")
  })
})

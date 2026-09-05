import { describe, expect, it } from "vitest"
import { nodeSandbox } from "../src/lib/code-sandbox-node"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// derive_code over the REAL MCP server: one call, many reads, the caller's own permissions.
//
// The value is a single boundary and a small result. A find plus many reads happens server-side;
// only the selected answer enters the model's context.
//
// The property that makes it safe is that it is not a new permission surface: the sandbox posts a
// tool NAME to the host, which runs the same handler with the same grant checks an ordinary call
// would hit. So these tests care most about "can it do more than the session could" — the answer
// has to be no.

/** The MCP endpoint answers as SSE (`event: message` then `data: {...}`), so the JSON is the last
 *  data: line — not the body. Reading the body directly yields undefined for everything, which
 *  looks exactly like a broken tool. */
const frameOf = (text: string): string => {
  const data = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
  return data.pop() ?? (text.trim().startsWith("{") ? text : "{}")
}

const mcp = async (
  app: ReturnType<typeof makeAuthedApp>["app"],
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  })
  const body = JSON.parse(frameOf(await res.text()))
  const content = body.result?.content?.[0]?.text
  return {
    status: res.status,
    isError: body.result?.isError === true,
    text: content as string | undefined,
    parsed: (() => {
      try {
        return JSON.parse(content)
      } catch {
        return null
      }
    })(),
  }
}

const listTools = async (app: ReturnType<typeof makeAuthedApp>["app"], token: string) => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  })
  return (JSON.parse(frameOf(await res.text())).result?.tools ?? []).map(
    (t: { name: string }) => t.name,
  )
}

const toolDefs = async (app: ReturnType<typeof makeAuthedApp>["app"], token: string) => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  })
  return (JSON.parse(frameOf(await res.text())).result?.tools ?? []) as {
    name: string
    description?: string
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
  }[]
}

describe("derive_code: registration", () => {
  const owner: TestUser = { id: "u_dc_own", email: "dcown@derive.test", name: "Owner" }

  it("registers when an isolate is injected, and NOT when one is absent", async () => {
    // No runtime sniffing: Cloudflare has no worker_threads, so the edge entry injects nothing
    // and the tool is absent there rather than present and broken.
    const withBox = makeAuthedApp("dc-on", [owner], "editor", {
      deps: { codeSandbox: nodeSandbox() },
    })
    const agentOn = (await (
      await withBox.app.request("/v1/agents", jsonAs(as(owner.email), { name: "A" }))
    ).json()) as { token: string }
    expect(await listTools(withBox.app, agentOn.token)).toContain("derive_code")
    const definitions = await toolDefs(withBox.app, agentOn.token)
    const code = definitions.find((tool) => tool.name === "derive_code")
    expect(code?.annotations?.readOnlyHint).toBe(true)
    expect(code?.annotations?.destructiveHint).toBe(false)
    expect(code?.description).toContain("Prefer for 2+ searches/reads")

    for (const name of ["find", "read"]) {
      const tool = definitions.find((item) => item.name === name)
      expect(tool?.description).toContain("Chains: `derive_code`")
    }

    const without = makeAuthedApp("dc-off", [owner], "editor")
    const agentOff = (await (
      await without.app.request("/v1/agents", jsonAs(as(owner.email), { name: "A" }))
    ).json()) as { token: string }
    expect(await listTools(without.app, agentOff.token)).not.toContain("derive_code")
  })
})

describe("derive_code: composing real tools", () => {
  const owner: TestUser = { id: "u_dc2_own", email: "dc2own@derive.test", name: "Owner" }
  const other: TestUser = { id: "u_dc2_other", email: "dc2other@derive.test", name: "Other" }
  const { app } = makeAuthedApp("dc-run", [owner, other], "editor", {
    deps: { codeSandbox: nodeSandbox() },
  })

  // Agent names are UNIQUE per workspace, so each test mints its OWN. Reusing one name yields no
  // token on the second call and every request 401s — which looks exactly like a broken tool.
  let n = 0
  const agentToken = async () => {
    n += 1
    const res = await app.request("/v1/agents", jsonAs(as(owner.email), { name: `CodeBot ${n}` }))
    const body = (await res.json()) as { token?: string }
    if (!body.token) throw new Error(`could not mint agent: ${res.status}`)
    return body.token
  }

  it("bulk finds and reads while inaccessible items skip cleanly", async () => {
    // Browse mode is deterministic in this fixture. The model makes one findMany and one
    // readMany call. The host batches the bridge and metadata work behind each call.
    const token = await agentToken()
    const hit = (await (
      await publishAs(
        app,
        `# Roadmap\n\nQ3 ships the thing.\n\n${"detail ".repeat(800)}END-OF-LONG-DOC`,
        { title: "R" },
        as(owner.email),
      )
    ).json()) as { short_id: string }
    const miss = (await (
      await publishAs(app, "# Notes\n\nNothing here.", { title: "N" }, as(owner.email))
    ).json()) as { short_id: string }
    const secret = (await (
      await publishAs(
        app,
        "# Secret\n\nPRIVATE-MARKER",
        { title: "Secret", workspace_access: "none", link_role: "none", listed: "none" },
        as(other.email),
      )
    ).json()) as { short_id: string }

    const out = await mcp(app, token, "derive_code", {
      code: `const wanted = new Set(${JSON.stringify([hit.short_id, miss.short_id])})
             const foundBatch = await tools.findMany([{}], { mode: "compact", max_chars: 2000 })
             const found = foundBatch.results[0].value
             const ids = found.results.map((row) => row.short_id).filter((id) => wanted.has(id))
             const docs = await tools.readMany([
               ...ids.map((short_id) => ({ short_id })),
               { short_id: ${JSON.stringify(miss.short_id)} },
               { short_id: ${JSON.stringify(secret.short_id)} },
             ], { mode: "compact", max_chars: 500 })
             return {
               matched: docs.results
                 .filter((row) => JSON.stringify(row.value).includes("Q3"))
                 .map((row) => ids[row.index]),
               stats: docs.stats,
               skipped: docs.skipped,
               resultText: JSON.stringify(docs.results),
             }`,
    })
    expect(out.isError).toBe(false)
    expect(out.parsed?.result?.matched).toEqual([hit.short_id])
    expect(out.parsed?.result?.stats).toMatchObject({
      requested: 4,
      completed: 3,
      skipped: 1,
      unique: 3,
      compact: true,
    })
    expect(out.parsed?.result?.skipped).toEqual([{ index: 3, reason: "unavailable" }])
    expect(out.parsed?.result?.resultText).not.toContain("END-OF-LONG-DOC")
    expect(out.parsed?.result?.resultText).not.toContain("PRIVATE-MARKER")
    // One logical find plus three logical reads stay visible in the audit line.
    expect(out.parsed?.tool_calls).toEqual(["find", "read", "read", "read", "read"])
  })

  it("surfaces logs and the calls made when the code FAILS halfway", async () => {
    // A composed script that dies partway is the case where "what did it already do" matters
    // most — returning a bare error would hide it.
    const token = await agentToken()
    const out = await mcp(app, token, "derive_code", {
      code: `console.log("starting")
             await tools.find({ query: "x" })
             throw new Error("halfway")`,
    })
    expect(out.isError).toBe(true)
    expect(out.text).toContain("halfway")
    expect(out.text).toContain("find")
    expect(out.text).toContain("starting")
  })

  it("exposes only find and read", async () => {
    const token = await agentToken()
    const viaCode = await mcp(app, token, "derive_code", {
      code: `return {
        find: typeof tools.find,
        findMany: typeof tools.findMany,
        read: typeof tools.read,
        readMany: typeof tools.readMany,
        publish: typeof tools.publish,
        list_workspaces: typeof tools.list_workspaces,
      }`,
    })
    expect(viaCode.isError).toBe(false)
    expect(viaCode.parsed?.result).toEqual({
      find: "function",
      findMany: "function",
      read: "function",
      readMany: "function",
      publish: "undefined",
      list_workspaces: "undefined",
    })
  })
})

import { describe, expect, it } from "vitest"
import { CHAT_TOOLS, RAIL_CHAT_TOOLS } from "../src/lib/chat-tools"

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

describe("which surfaces hold call", () => {
  it("the workspace chat holds it", () => {
    expect(CHAT_TOOLS.has("call")).toBe(true)
  })

  it("the document rail does NOT — it is a read-only lane about one document", () => {
    expect(RAIL_CHAT_TOOLS.has("call")).toBe(false)
    expect([...RAIL_CHAT_TOOLS].sort()).toEqual(["find", "read"])
  })

  it("is registered opt-in, so an external client cannot receive it by default", async () => {
    // The registration reads `only?.has("call")`, never `wanted("call")`. If someone
    // "simplifies" it to match its neighbours, external MCP clients silently gain a tool that
    // spends the workspace's credentials — this asserts the source keeps the stricter form.
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../src/mcp.ts", import.meta.url), "utf8"),
    )
    expect(src).toContain('only?.has("call")')
    expect(src).not.toContain('wanted("call")')
  })
})

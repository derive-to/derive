import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { afterEach, describe, expect, it } from "vitest"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("stdio MCP onboarding surface", () => {
  it("advertises instructions, the real tool set, and readable guide resources", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "derive-mcp-surface-"))
    dirs.push(configDir)
    const here = dirname(fileURLToPath(import.meta.url))
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(here, "../bin/derive-mcp.mjs")],
      env: {
        DERIVE_CONFIG_DIR: configDir,
        DERIVE_SERVER: "http://127.0.0.1:1",
      },
    })
    const client = new Client({ name: "derive-surface-test", version: "1.0.0" })

    try {
      await client.connect(transport)
      expect(client.getInstructions()).toContain("Read derive://guide before the first write")

      const listed = (await client.listTools()).tools
      const tools = listed.map((tool) => tool.name)
      expect(tools).toEqual([
        "list_workspaces",
        "list_artifacts",
        "search",
        "read",
        "catch_up",
        "comment",
        "organize",
        "publish",
      ])

      // The read path advertises readOnlyHint so annotation-honoring clients run it
      // without an approval prompt; comment/organize/publish are writers and carry
      // readOnlyHint: false instead (asserted below alongside every tool's title).
      const readOnly = listed
        .filter((tool) => tool.annotations?.readOnlyHint === true)
        .map((tool) => tool.name)
      expect(readOnly).toEqual(["list_workspaces", "list_artifacts", "search", "read", "catch_up"])

      // Directory listings and clients' auto-approval UX both read `annotations` —
      // every tool needs a human-readable title and an explicit (not merely absent)
      // readOnlyHint, never left to a reviewer's guess.
      expect(listed.length).toBeGreaterThan(0)
      for (const tool of listed) {
        expect(tool.annotations?.title, `${tool.name} title`).toBeTruthy()
        expect(typeof tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe("boolean")
      }

      const resources = (await client.listResources()).resources.map((resource) => resource.uri)
      expect(resources).toEqual(
        expect.arrayContaining([
          "derive://guide",
          "derive://guide/connect",
          "derive://guide/compatibility",
        ]),
      )

      const guide = await client.callTool({
        name: "read",
        arguments: { short_id: "derive://guide" },
      })
      expect(JSON.stringify(guide)).toContain("name: derive")

      for (const short_id of ["derive://guide/missing", "derive://guide/constructor"]) {
        const missing = await client.callTool({
          name: "read",
          arguments: { short_id },
        })
        expect(missing.isError).toBe(true)
        expect(JSON.stringify(missing)).toContain("No guide reference")
      }
    } finally {
      await client.close()
    }
  })
})

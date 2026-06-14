import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  CONFIG_FILE,
  defaultConfig,
  formatComments,
  loadConfig,
  loadCredentials,
  resolvePublish,
  saveToken,
  scaffold,
  scaffoldFiles,
  TEMPLATES,
  tokenFor,
  writeId,
} from "../src/config.js"

const dirs = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "dock-cli-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("scaffold", () => {
  it("md template writes dock.json + index.md + AGENTS.md + the agent on-ramp", () => {
    const d = tmp()
    const { created } = scaffold(d, "Report", "md")
    expect(created.sort()).toEqual([
      ".claude/skills/dock/SKILL.md",
      ".mcp.json",
      "AGENTS.md",
      "dock.json",
      "dock.schema.json",
      "index.md",
    ])
    const cfg = JSON.parse(readFileSync(join(d, CONFIG_FILE), "utf8"))
    expect(cfg).toMatchObject({ title: "Report", entry: "index.md", id: null, visibility: "link" })
    // The MCP config + skill are present and reference the published server.
    expect(JSON.parse(readFileSync(join(d, ".mcp.json"), "utf8")).mcpServers.dock.args).toContain(
      "@dock/mcp",
    )
    expect(readFileSync(join(d, ".claude/skills/dock/SKILL.md"), "utf8")).toContain(
      "name: dock-publish",
    )
  })

  it("html template uses index.html as the entry", () => {
    const d = tmp()
    scaffold(d, "Page", "html")
    expect(JSON.parse(readFileSync(join(d, CONFIG_FILE), "utf8")).entry).toBe("index.html")
    expect(readFileSync(join(d, "index.html"), "utf8")).toContain("<title>Page</title>")
  })

  it("slides template scaffolds a deck with controls + the dock-deck protocol", () => {
    const d = tmp()
    const { created } = scaffold(d, "Talk", "slides")
    expect(created).toContain("slides.html")
    const html = readFileSync(join(d, "slides.html"), "utf8")
    expect(JSON.parse(readFileSync(join(d, CONFIG_FILE), "utf8")).entry).toBe("slides.html")
    expect(html).toContain('class="slide')
    expect(html).toMatch(/ArrowRight|ArrowLeft/) // keyboard navigation
    expect(html).toMatch(/data-act="prev"|data-act="next"/) // on-screen prev/next
    expect(html).toContain('data-act="full"') // fullscreen control
    expect(html).toContain("source:'dock-deck'") // announces state to the host
    expect(html).toMatch(/dock-host[\s\S]*deck/) // accepts host drive commands
  })

  it("never clobbers existing files", () => {
    const d = tmp()
    writeFileSync(join(d, CONFIG_FILE), '{"title":"mine","id":"keep"}')
    const { created, skipped } = scaffold(d, "X", "md")
    expect(skipped).toContain(CONFIG_FILE)
    expect(created).not.toContain(CONFIG_FILE)
    expect(JSON.parse(readFileSync(join(d, CONFIG_FILE), "utf8")).id).toBe("keep")
  })

  it("site template scaffolds a multi-file bundle with a directory entry", () => {
    const d = tmp()
    const { created } = scaffold(d, "Docs", "site")
    expect(created).toEqual(
      expect.arrayContaining(["site/index.html", "site/about.html", "site/style.css"]),
    )
    expect(JSON.parse(readFileSync(join(d, CONFIG_FILE), "utf8")).entry).toBe("site")
  })

  it("writes a dock.schema.json and references it from dock.json", () => {
    const d = tmp()
    scaffold(d, "X", "md")
    const cfg = JSON.parse(readFileSync(join(d, CONFIG_FILE), "utf8"))
    expect(cfg.$schema).toBe("./dock.schema.json")
    const schema = JSON.parse(readFileSync(join(d, "dock.schema.json"), "utf8"))
    expect(schema.properties.visibility.enum).toContain("link")
  })

  it("exposes the four templates", () => {
    expect(TEMPLATES).toEqual(["md", "html", "slides", "site"])
    expect(Object.keys(scaffoldFiles("T", "slides"))).toContain("slides.html")
  })
})

describe("formatComments", () => {
  const c = (id, tid, author, body, state = "open", anchor = null) => ({
    id,
    thread_id: tid,
    author,
    body_md: body,
    state,
    anchor,
  })
  it("returns a friendly message when empty", () => {
    expect(formatComments([])).toBe("No comments yet.")
  })
  it("groups by thread and shows author, body, and state glyph", () => {
    const out = formatComments([
      c("c1", "t1", "ava", "looks off", "open"),
      c("c2", "t1", "bo", "fixed"),
      c("c3", "t2", "ci", "done", "resolved"),
    ])
    expect(out).toContain("○ thread t1")
    expect(out).toContain("    ava: looks off")
    expect(out).toContain("    bo: fixed")
    expect(out).toContain("✓ thread t2")
  })
  it("shows the anchored quote when present", () => {
    const out = formatComments([
      c("c1", "t1", "ava", "tighten", "open", JSON.stringify({ exact: "p99 budget" })),
    ])
    expect(out).toContain("“p99 budget”")
  })
})

describe("loadConfig", () => {
  it("returns null when no dock.json", () => {
    expect(loadConfig(tmp())).toBeNull()
  })
  it("parses dock.json", () => {
    const d = tmp()
    writeFileSync(join(d, CONFIG_FILE), JSON.stringify(defaultConfig("Y")))
    expect(loadConfig(d)).toMatchObject({ title: "Y", entry: "index.md" })
  })
  it("throws a clear error on malformed JSON", () => {
    const d = tmp()
    writeFileSync(join(d, CONFIG_FILE), "{ not json")
    expect(() => loadConfig(d)).toThrow(/not valid JSON/)
  })
})

describe("resolvePublish", () => {
  it("flags win over config win over defaults", () => {
    const cfg = {
      id: "cfg",
      title: "cfgTitle",
      entry: "doc.md",
      visibility: "org",
      spa: true,
      server: "http://cfg",
    }
    const r = resolvePublish({ title: "flagTitle", server: "http://flag" }, cfg)
    expect(r.title).toBe("flagTitle") // flag wins
    expect(r.id).toBe("cfg") // from config
    expect(r.target).toBe("doc.md") // config entry
    expect(r.visibility).toBe("org")
    expect(r.spa).toBe(true)
    expect(r.server).toBe("http://flag")
  })
  it("falls back to defaults with no config", () => {
    const r = resolvePublish({ target: "x.md" }, null)
    expect(r.id).toBeNull()
    expect(r.target).toBe("x.md")
    expect(r.server).toBe("http://localhost:8080")
  })
  it("--spa flag string coerces to boolean", () => {
    expect(resolvePublish({ spa: "true" }, null).spa).toBe(true)
    expect(resolvePublish({}, { spa: false }).spa).toBe(false)
  })
})

describe("writeId", () => {
  it("writes the assigned id, preserving other keys", () => {
    const d = tmp()
    scaffold(d, "Doc", "md")
    writeId(d, "ab12cd34")
    const cfg = JSON.parse(readFileSync(join(d, CONFIG_FILE), "utf8"))
    expect(cfg.id).toBe("ab12cd34")
    expect(cfg.title).toBe("Doc") // untouched
    expect(cfg.entry).toBe("index.md")
  })
  it("creates a config if missing", () => {
    const d = tmp()
    writeId(d, "zz99")
    expect(loadConfig(d).id).toBe("zz99")
  })
})

describe("credentials (dock login)", () => {
  // Isolate the user-level store in a tmp dir, and keep DOCK_TOKEN out of the way.
  let prevDir
  let prevToken
  beforeEach(() => {
    prevDir = process.env.DOCK_CONFIG_DIR
    prevToken = process.env.DOCK_TOKEN
    process.env.DOCK_CONFIG_DIR = tmp()
    delete process.env.DOCK_TOKEN
  })
  const restore = (key, prev) => {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
  afterEach(() => {
    restore("DOCK_CONFIG_DIR", prevDir)
    restore("DOCK_TOKEN", prevToken)
  })

  it("saves and reads a token per server origin", () => {
    expect(tokenFor("https://dock.example.com")).toBeNull()
    saveToken("https://dock.example.com/some/path", "tok_abc")
    // Stored + read by origin, so a path on the same host resolves the same token.
    expect(tokenFor("https://dock.example.com")).toBe("tok_abc")
    expect(tokenFor("https://dock.example.com/other")).toBe("tok_abc")
    expect(loadCredentials()["https://dock.example.com"].token).toBe("tok_abc")
  })

  it("keeps separate tokens for different servers", () => {
    saveToken("https://a.dock.com", "tok_a")
    saveToken("https://b.dock.com", "tok_b")
    expect(tokenFor("https://a.dock.com")).toBe("tok_a")
    expect(tokenFor("https://b.dock.com")).toBe("tok_b")
  })

  it("resolvePublish uses the saved token for the resolved server", () => {
    saveToken("https://dock.example.com", "tok_login")
    const r = resolvePublish({ server: "https://dock.example.com" }, null)
    expect(r.token).toBe("tok_login")
  })

  it("explicit --token and DOCK_TOKEN win over the saved token", () => {
    saveToken("https://dock.example.com", "tok_login")
    expect(
      resolvePublish({ server: "https://dock.example.com", token: "tok_flag" }, null).token,
    ).toBe("tok_flag")
    process.env.DOCK_TOKEN = "tok_env"
    expect(resolvePublish({ server: "https://dock.example.com" }, null).token).toBe("tok_env")
  })
})

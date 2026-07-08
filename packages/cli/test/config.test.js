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
  writeContextConfig,
  writeId,
} from "../src/config.js"

const dirs = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "derive-cli-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("scaffold", () => {
  it("md template writes derive.json + index.md + AGENTS.md + the agent on-ramp", () => {
    const d = tmp()
    const { created } = scaffold(d, "Report", "md")
    expect(created.sort()).toEqual([
      ".claude/skills/derive/SKILL.md",
      ".mcp.json",
      "AGENTS.md",
      "derive.json",
      "derive.schema.json",
      "index.md",
    ])
    const cfg = JSON.parse(readFileSync(join(d, CONFIG_FILE), "utf8"))
    expect(cfg).toMatchObject({
      title: "Report",
      entry: "index.md",
      id: null,
      visibility: "private",
    })
    // The MCP config + skill are present and reference the published server.
    expect(JSON.parse(readFileSync(join(d, ".mcp.json"), "utf8")).mcpServers.derive.args).toContain(
      "@derive-to/mcp",
    )
    expect(readFileSync(join(d, ".claude/skills/derive/SKILL.md"), "utf8")).toContain(
      "name: derive-publish",
    )
  })

  it("html template uses index.html as the entry", () => {
    const d = tmp()
    scaffold(d, "Page", "html")
    expect(JSON.parse(readFileSync(join(d, CONFIG_FILE), "utf8")).entry).toBe("index.html")
    expect(readFileSync(join(d, "index.html"), "utf8")).toContain("<title>Page</title>")
  })

  it("slides template scaffolds a deck with controls + the derive-deck protocol", () => {
    const d = tmp()
    const { created } = scaffold(d, "Talk", "slides")
    expect(created).toContain("slides.html")
    const html = readFileSync(join(d, "slides.html"), "utf8")
    expect(JSON.parse(readFileSync(join(d, CONFIG_FILE), "utf8")).entry).toBe("slides.html")
    expect(html).toContain('class="slide')
    expect(html).toMatch(/ArrowRight|ArrowLeft/) // keyboard navigation
    expect(html).toMatch(/data-act="prev"|data-act="next"/) // on-screen prev/next
    expect(html).toContain('data-act="full"') // fullscreen control
    expect(html).toContain("source:'derive-deck'") // announces state to the host
    expect(html).toMatch(/derive-host[\s\S]*deck/) // accepts host drive commands
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

  it("writes a derive.schema.json and references it from derive.json", () => {
    const d = tmp()
    scaffold(d, "X", "md")
    const cfg = JSON.parse(readFileSync(join(d, CONFIG_FILE), "utf8"))
    expect(cfg.$schema).toBe("./derive.schema.json")
    const schema = JSON.parse(readFileSync(join(d, "derive.schema.json"), "utf8"))
    expect(schema.properties.visibility.enum).toEqual(["public", "org", "private"])
  })

  it("exposes the templates", () => {
    expect(TEMPLATES).toEqual(["md", "html", "slides", "site", "skill", "context"])
    expect(Object.keys(scaffoldFiles("T", "slides"))).toContain("slides.html")
  })

  it("scaffolds a skill: SKILL.md (with frontmatter) + scripts + references", () => {
    const files = scaffoldFiles("My Cool Skill", "skill")
    const names = Object.keys(files)
    expect(names).toContain("skill/SKILL.md")
    expect(names).toContain("skill/scripts/example.sh")
    expect(names).toContain("skill/references/example.md")
    const md = files["skill/SKILL.md"]
    expect(md).toMatch(/^---\nname: my-cool-skill\n/) // title slugified to a skill name
    expect(md).toContain("description:")
  })

  it("scaffolds a context: manifest + references + tools + env hygiene", () => {
    const files = scaffoldFiles("Analytics", "context")
    const names = Object.keys(files)
    expect(names).toContain("context/MANIFEST.md")
    expect(names).toContain("context/references/example.md")
    expect(names).toContain("context/.mcp.json")
    expect(names).toContain("context/.env.example")
    // .env and the minted agent token must never reach git.
    expect(files[".gitignore"]).toContain("context/.env")
    expect(files[".gitignore"]).toContain(".derive/")
    const cfg = JSON.parse(files[CONFIG_FILE])
    expect(cfg.entry).toBe("context")
    expect(cfg.context).toEqual({ id: null, agent_id: null, name: "Analytics" })
  })
})

describe("writeContextConfig", () => {
  it("merges wiring ids into the context block, preserving everything else", () => {
    const d = tmp()
    writeFileSync(
      join(d, CONFIG_FILE),
      JSON.stringify({ title: "T", entry: "context", id: "abc", context: { id: null, name: "T" } }),
    )
    writeContextConfig(d, { agent_id: "ag_1" })
    const cfg = writeContextConfig(d, { id: "ctx_1" })
    expect(cfg).toMatchObject({
      title: "T",
      id: "abc",
      context: { id: "ctx_1", agent_id: "ag_1", name: "T" },
    })
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
  it("returns null when no derive.json", () => {
    expect(loadConfig(tmp())).toBeNull()
  })
  it("parses derive.json", () => {
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
  it("falls back to the cloud server with no config", () => {
    const r = resolvePublish({ target: "x.md" }, null)
    expect(r.id).toBeNull()
    expect(r.target).toBe("x.md")
    expect(r.server).toBe("https://derive.to")
  })
  it("--local targets a dev server; --server overrides", () => {
    expect(resolvePublish({ local: true }, null).server).toBe("http://localhost:8080")
    expect(resolvePublish({ server: "http://localhost:8099" }, null).server).toBe(
      "http://localhost:8099",
    )
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

describe("credentials (derive login)", () => {
  // Isolate the user-level store in a tmp dir, and keep DERIVE_TOKEN out of the way.
  let prevDir
  let prevToken
  beforeEach(() => {
    prevDir = process.env.DERIVE_CONFIG_DIR
    prevToken = process.env.DERIVE_TOKEN
    process.env.DERIVE_CONFIG_DIR = tmp()
    delete process.env.DERIVE_TOKEN
  })
  const restore = (key, prev) => {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
  afterEach(() => {
    restore("DERIVE_CONFIG_DIR", prevDir)
    restore("DERIVE_TOKEN", prevToken)
  })

  it("saves and reads a token per server origin", () => {
    expect(tokenFor("https://derive.example.com")).toBeNull()
    saveToken("https://derive.example.com/some/path", "tok_abc")
    // Stored + read by origin, so a path on the same host resolves the same token.
    expect(tokenFor("https://derive.example.com")).toBe("tok_abc")
    expect(tokenFor("https://derive.example.com/other")).toBe("tok_abc")
    expect(loadCredentials()["https://derive.example.com"].token).toBe("tok_abc")
  })

  it("keeps separate tokens for different servers", () => {
    saveToken("https://a.derive.com", "tok_a")
    saveToken("https://b.derive.com", "tok_b")
    expect(tokenFor("https://a.derive.com")).toBe("tok_a")
    expect(tokenFor("https://b.derive.com")).toBe("tok_b")
  })

  it("resolvePublish uses the saved token for the resolved server", () => {
    saveToken("https://derive.example.com", "tok_login")
    const r = resolvePublish({ server: "https://derive.example.com" }, null)
    expect(r.token).toBe("tok_login")
  })

  it("explicit --token and DERIVE_TOKEN win over the saved token", () => {
    saveToken("https://derive.example.com", "tok_login")
    expect(
      resolvePublish({ server: "https://derive.example.com", token: "tok_flag" }, null).token,
    ).toBe("tok_flag")
    process.env.DERIVE_TOKEN = "tok_env"
    expect(resolvePublish({ server: "https://derive.example.com" }, null).token).toBe("tok_env")
  })
})

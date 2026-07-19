import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  agentScaffoldFiles,
  CONFIG_FILE,
  defaultConfig,
  describeWorkspace,
  entryFor,
  findAccountWorkspace,
  forgetWorkspace,
  formatComments,
  freshToken,
  getAccount,
  getClientId,
  getDefault,
  listAccounts,
  loadConfig,
  mergeChosenWorkspaces,
  removeAccount,
  resolveAccountRef,
  resolvePublish,
  resolveWorkspaceRef,
  saveAccount,
  saveClientId,
  scaffold,
  scaffoldAgent,
  scaffoldFiles,
  setDefaultAccount,
  setDefaultWorkspace,
  setWorkspaces,
  TEMPLATES,
  writeContextConfig,
  writeId,
  writeSkillPin,
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
  it("md template writes derive.json + index.md + the Codex/Claude agent on-ramp", () => {
    const d = tmp()
    const { created } = scaffold(d, "Report", "md")
    expect(created).toEqual(
      expect.arrayContaining([
        ".agents/skills/derive/SKILL.md",
        ".agents/skills/derive/agents/openai.yaml",
        ".claude/skills/derive/SKILL.md",
        ".codex/config.toml",
        ".mcp.json",
        "AGENTS.md",
        "derive.json",
        "derive.schema.json",
        "index.md",
      ]),
    )
    const cfg = JSON.parse(readFileSync(join(d, CONFIG_FILE), "utf8"))
    expect(cfg).toMatchObject({
      title: "Report",
      entry: "index.md",
      id: null,
    })
    // No `visibility` — a scaffold inherits the workspace's team-draft default
    // (workspace access, unlisted), not invite-only.
    expect(cfg.visibility).toBeUndefined()
    // Both harnesses get their native skill location and the OAuth remote MCP.
    expect(JSON.parse(readFileSync(join(d, ".mcp.json"), "utf8")).mcpServers.derive).toEqual({
      type: "http",
      url: ["$", "{DERIVE_MCP_URL:-https://derive.to/mcp}"].join(""),
    })
    expect(readFileSync(join(d, ".codex/config.toml"), "utf8")).toContain(
      'url = "https://derive.to/mcp"',
    )
    const codexSkill = readFileSync(join(d, ".agents/skills/derive/SKILL.md"), "utf8")
    const claudeSkill = readFileSync(join(d, ".claude/skills/derive/SKILL.md"), "utf8")
    expect(codexSkill).toBe(claudeSkill)
    expect(codexSkill).toContain("name: derive")
    expect(readFileSync(join(d, ".agents/skills/derive/agents/openai.yaml"), "utf8")).toContain(
      'url: "https://derive.to/mcp"',
    )
  })

  it("installs the agent on-ramp alone and never clobbers an existing config", () => {
    const d = tmp()
    writeFileSync(join(d, ".mcp.json"), '{"mine":true}\n')
    const { created, skipped } = scaffoldAgent(d)
    expect(created).toContain(".agents/skills/derive/SKILL.md")
    expect(created).toContain(".claude/skills/derive/SKILL.md")
    expect(created).toContain(".codex/config.toml")
    expect(skipped).toContain(".mcp.json")
    expect(readFileSync(join(d, ".mcp.json"), "utf8")).toBe('{"mine":true}\n')
    expect(Object.keys(agentScaffoldFiles())).toHaveLength(10)
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
    // Canonical v2 access fields are the documented interface…
    expect(schema.properties.workspace_access.enum).toEqual(["none", "member"])
    expect(schema.properties.link_role.enum).toEqual(["none", "viewer", "commenter", "editor"])
    expect(schema.properties.listed.enum).toEqual(["none", "workspace", "public"])
    // …and `visibility` stays as a deprecated alias for old files.
    expect(schema.properties.visibility.enum).toEqual(["public", "org", "private"])
    expect(schema.properties.visibility.deprecated).toBe(true)
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
    // .env, the minted agent token, and the clone workspace must never reach git.
    expect(files[".gitignore"]).toContain("context/.env")
    expect(files[".gitignore"]).toContain(".derive/")
    expect(files[".gitignore"]).toContain("context/repos/")
    // The repo-pointer example ships commented out — scaffolds must parse to zero repos.
    expect(files["context/MANIFEST.md"]).toContain("# repos:")
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

describe("writeSkillPin", () => {
  it("appends a pin, and a re-add for the same id repins instead of duplicating", () => {
    const d = tmp()
    writeFileSync(join(d, CONFIG_FILE), JSON.stringify({ title: "T", entry: "context" }))
    writeSkillPin(d, { id: "sk1", version: 3, name: "chart-style" })
    let cfg = writeSkillPin(d, { id: "sk2", version: 1 })
    expect(cfg.skills).toEqual([
      { id: "sk1", version: 3, name: "chart-style" },
      { id: "sk2", version: 1 },
    ])
    // Re-adding sk1 at a new version replaces it in place (still 2 entries).
    cfg = writeSkillPin(d, { id: "sk1", version: 4, name: "chart-style" })
    expect(cfg.skills).toHaveLength(2)
    expect(cfg.skills.find((s) => s.id === "sk1").version).toBe(4)
    expect(cfg.title).toBe("T") // untouched
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
  it("resolves the v2 access fields: flag (hyphenated) > derive.json; else undefined", () => {
    // derive.json carries the canonical keys…
    const fromCfg = resolvePublish({}, { workspace_access: "none", link_role: "viewer" })
    expect(fromCfg.workspaceAccess).toBe("none")
    expect(fromCfg.linkRole).toBe("viewer")
    expect(fromCfg.listed).toBeUndefined()
    // …and a --link-role/--listed flag wins over it.
    const withFlags = resolvePublish(
      { "link-role": "editor", listed: "public" },
      { link_role: "viewer" },
    )
    expect(withFlags.linkRole).toBe("editor")
    expect(withFlags.listed).toBe("public")
    // Nothing set ⇒ all undefined, so the publish inherits the workspace default.
    const bare = resolvePublish({ target: "x.md" }, null)
    expect(bare.workspaceAccess).toBeUndefined()
    expect(bare.linkRole).toBeUndefined()
    expect(bare.listed).toBeUndefined()
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
    vi.unstubAllGlobals()
  })

  const SERVER = "https://derive.example.com"

  describe("saveAccount / setWorkspaces", () => {
    it("the first account saved on a server becomes its default", () => {
      expect(getDefault(SERVER)).toBeNull()
      saveAccount(SERVER, "u1", { handle: "ava", grant: { token: "tok1" } })
      expect(getDefault(SERVER)).toEqual({ account: "u1", workspace: null })
      expect(getAccount(SERVER, "u1").handle).toBe("ava")
      expect(getAccount(SERVER, "u1").auth.token).toBe("tok1")
    })

    it("a second account does not steal the default", () => {
      saveAccount(SERVER, "u1", { grant: { token: "tok1" } })
      saveAccount(SERVER, "u2", { grant: { token: "tok2" } })
      expect(getDefault(SERVER).account).toBe("u1")
      expect(
        listAccounts(SERVER)
          .map((a) => a.id)
          .sort(),
      ).toEqual(["u1", "u2"])
    })

    it("setWorkspaces auto-picks an owner-role default over the first entry", () => {
      saveAccount(SERVER, "u1", { grant: { token: "tok1" } })
      setWorkspaces(SERVER, "u1", {
        ws_a: { name: "A", role: "editor" },
        ws_b: { name: "B", role: "owner" },
      })
      expect(getDefault(SERVER).workspace).toBe("ws_b")
    })

    it("falls back to the first entry when no workspace is owner-role", () => {
      saveAccount(SERVER, "u1", { grant: { token: "tok1" } })
      setWorkspaces(SERVER, "u1", { ws_a: { name: "A", role: "viewer" } })
      expect(getDefault(SERVER).workspace).toBe("ws_a")
    })

    it("reports added/renamed/removed against the previous roster", () => {
      saveAccount(SERVER, "u1", { grant: { token: "tok1" } })
      setWorkspaces(SERVER, "u1", {
        ws_a: { name: "A", role: "owner" },
        ws_b: { name: "B", role: "editor" },
      })
      const diff = setWorkspaces(SERVER, "u1", {
        ws_a: { name: "A Renamed", role: "owner" },
        ws_c: { name: "C", role: "editor" },
      })
      expect(diff.added).toEqual([{ id: "ws_c", name: "C" }])
      expect(diff.renamed).toEqual([{ id: "ws_a", from: "A", to: "A Renamed" }])
      expect(diff.removed).toEqual([{ id: "ws_b", name: "B" }])
    })

    it("re-picks the default when it drops out of a re-synced roster", () => {
      saveAccount(SERVER, "u1", { grant: { token: "tok1" } })
      setWorkspaces(SERVER, "u1", { ws_a: { name: "A", role: "owner" } })
      setDefaultWorkspace(SERVER, "u1", "ws_a")
      setWorkspaces(SERVER, "u1", { ws_b: { name: "B", role: "editor" } })
      expect(getDefault(SERVER).workspace).toBe("ws_b")
    })
  })

  describe("mergeChosenWorkspaces (derive login --workspace/--pick vs. an already-synced account)", () => {
    it("merges a narrowed selection into an existing roster instead of replacing it", () => {
      const existing = {
        ws_a: { name: "A", role: "owner" },
        ws_b: { name: "B", role: "editor" },
        ws_c: { name: "C", role: "viewer" },
      }
      const chosen = { ws_b: { name: "B", role: "owner" } } // e.g. --workspace "B", role refreshed
      const merged = mergeChosenWorkspaces(existing, chosen, true)
      expect(merged).toEqual({
        ws_a: { name: "A", role: "owner" },
        ws_b: { name: "B", role: "owner" }, // refreshed, not stale
        ws_c: { name: "C", role: "viewer" },
      })
    })

    it("uses chosen as-is when there's no existing roster to protect (a fresh account)", () => {
      const chosen = { ws_b: { name: "B", role: "owner" } }
      expect(mergeChosenWorkspaces({}, chosen, true)).toBe(chosen)
    })

    it("uses chosen as-is when not narrowing (a full discovery legitimately replaces/diffs the roster)", () => {
      const existing = { ws_a: { name: "A", role: "owner" }, ws_b: { name: "B", role: "editor" } }
      const chosen = { ws_a: { name: "A", role: "owner" } } // e.g. the account left ws_b server-side
      expect(mergeChosenWorkspaces(existing, chosen, false)).toBe(chosen)
    })

    it("end to end: derive login --workspace on an already-synced account keeps the others", () => {
      saveAccount(SERVER, "u1", { grant: { token: "tok1" } })
      setWorkspaces(SERVER, "u1", {
        ws_a: { name: "A", role: "owner" },
        ws_b: { name: "B", role: "editor" },
        ws_c: { name: "C", role: "viewer" },
      })
      const chosen = { ws_b: { name: "B", role: "editor" } } // re-login narrowed to just B
      const toSave = mergeChosenWorkspaces(getAccount(SERVER, "u1").workspaces, chosen, true)
      setWorkspaces(SERVER, "u1", toSave)
      expect(Object.keys(getAccount(SERVER, "u1").workspaces).sort()).toEqual([
        "ws_a",
        "ws_b",
        "ws_c",
      ])
    })
  })

  describe("legacy migration", () => {
    it("reads a pre-multi-workspace flat grant as a synthetic default account", () => {
      // The on-disk shape this store used before accounts existed.
      writeFileSync(
        join(process.env.DERIVE_CONFIG_DIR, "credentials.json"),
        JSON.stringify({
          [SERVER]: {
            token: "old_tok",
            refresh_token: "old_refresh",
            client_id: "old_client",
            expires_at: null,
            saved_at: "2020-01-01T00:00:00.000Z",
          },
        }),
      )
      expect(getDefault(SERVER)).toEqual({ account: "legacy", workspace: null })
      const account = getAccount(SERVER, "legacy")
      expect(account.auth.token).toBe("old_tok")
      expect(account.auth.refresh_token).toBe("old_refresh")
      expect(resolvePublish({ server: SERVER }, null).token).toBe("old_tok")
    })

    it("is idempotent — reading twice does not change what's on disk", () => {
      writeFileSync(
        join(process.env.DERIVE_CONFIG_DIR, "credentials.json"),
        JSON.stringify({ [SERVER]: { token: "old_tok" } }),
      )
      const before = readFileSync(join(process.env.DERIVE_CONFIG_DIR, "credentials.json"), "utf8")
      getDefault(SERVER)
      entryFor(SERVER)
      const after = readFileSync(join(process.env.DERIVE_CONFIG_DIR, "credentials.json"), "utf8")
      expect(after).toBe(before)
    })
  })

  describe("resolveAccountRef / findAccountWorkspace", () => {
    beforeEach(() => {
      saveAccount(SERVER, "u1", { handle: "ava", grant: { token: "tok1" } })
      setWorkspaces(SERVER, "u1", { ws_a: { name: "Acme Co", role: "owner" } })
    })
    it("resolves by id", () => {
      expect(resolveAccountRef(SERVER, "u1")).toBe("u1")
    })
    it("resolves by handle, case-insensitively, with or without @", () => {
      expect(resolveAccountRef(SERVER, "ava")).toBe("u1")
      expect(resolveAccountRef(SERVER, "@ava")).toBe("u1")
      expect(resolveAccountRef(SERVER, "@AVA")).toBe("u1")
    })
    it("returns null for an unknown ref", () => {
      expect(resolveAccountRef(SERVER, "nobody")).toBeNull()
    })
    it("finds a workspace by id or case-insensitive name within an account", () => {
      expect(findAccountWorkspace(SERVER, "u1", "ws_a")).toEqual({ id: "ws_a", name: "Acme Co" })
      expect(findAccountWorkspace(SERVER, "u1", "acme co")).toEqual({ id: "ws_a", name: "Acme Co" })
      expect(findAccountWorkspace(SERVER, "u1", "nope")).toBeNull()
    })
  })

  describe("setDefaultAccount / setDefaultWorkspace / forgetWorkspace / removeAccount", () => {
    beforeEach(() => {
      saveAccount(SERVER, "u1", { handle: "ava", grant: { token: "tok1" } })
      saveAccount(SERVER, "u2", { handle: "bo", grant: { token: "tok2" } })
      setWorkspaces(SERVER, "u1", {
        ws_a: { name: "Personal", role: "owner" },
        ws_b: { name: "Acme Co", role: "editor" },
      })
    })

    it("setDefaultAccount switches which account resolves by default", () => {
      setDefaultAccount(SERVER, "u2")
      expect(getDefault(SERVER).account).toBe("u2")
    })
    it("setDefaultAccount throws on an unknown account", () => {
      expect(() => setDefaultAccount(SERVER, "ghost")).toThrow(/no such account/)
    })

    it("setDefaultWorkspace resolves by name and persists", () => {
      const w = setDefaultWorkspace(SERVER, "u1", "Acme Co")
      expect(w).toEqual({ id: "ws_b", name: "Acme Co" })
      expect(getDefault(SERVER).workspace).toBe("ws_b")
    })
    it("setDefaultWorkspace throws a clear error and does not partially apply", () => {
      expect(() => setDefaultWorkspace(SERVER, "u1", "Nope")).toThrow(/no workspace/)
      expect(getDefault(SERVER).workspace).toBe("ws_a") // unchanged
    })

    it("forgetWorkspace drops it locally and re-picks the default if needed", () => {
      const removed = forgetWorkspace(SERVER, "u1", "ws_a")
      expect(removed).toEqual({ id: "ws_a", name: "Personal" })
      expect(getAccount(SERVER, "u1").workspaces.ws_a).toBeUndefined()
      expect(getDefault(SERVER).workspace).toBe("ws_b") // re-picked
    })
    it("forgetWorkspace returns null for an unknown ref", () => {
      expect(forgetWorkspace(SERVER, "u1", "nope")).toBeNull()
    })

    it("removeAccount falls back the default to a remaining account", () => {
      expect(removeAccount(SERVER, "u1")).toBe(true)
      expect(getDefault(SERVER).account).toBe("u2")
      expect(listAccounts(SERVER)).toEqual([
        { id: "u2", handle: "bo", workspaceCount: 0, isDefault: true },
      ])
    })
    it("removeAccount returns false for an account that was never there", () => {
      expect(removeAccount(SERVER, "ghost")).toBe(false)
    })
  })

  describe("describeWorkspace", () => {
    beforeEach(() => {
      saveAccount(SERVER, "u1", { handle: "ava", grant: { token: "tok1" } })
      setWorkspaces(SERVER, "u1", {
        ws_a: { name: "Personal", role: "owner" },
        ws_b: { name: "Acme Co", role: "editor" },
      })
    })

    it("sets a local description, resolvable by name or id", () => {
      const w = describeWorkspace(SERVER, "u1", "Acme Co", "Client work — never internal drafts.")
      expect(w).toEqual({ id: "ws_b", name: "Acme Co" })
      expect(getAccount(SERVER, "u1").workspaces.ws_b.description).toBe(
        "Client work — never internal drafts.",
      )
      // untouched workspace has no description key at all
      expect(getAccount(SERVER, "u1").workspaces.ws_a.description).toBeUndefined()
    })

    it("clearing with null removes the description key", () => {
      describeWorkspace(SERVER, "u1", "ws_a", "Scratch space")
      describeWorkspace(SERVER, "u1", "ws_a", null)
      expect(getAccount(SERVER, "u1").workspaces.ws_a.description).toBeUndefined()
    })

    it("throws for an unknown workspace, without partially applying", () => {
      expect(() => describeWorkspace(SERVER, "u1", "Nope", "x")).toThrow(/no workspace/)
    })
    it("throws for an unknown account", () => {
      expect(() => describeWorkspace(SERVER, "ghost", "ws_a", "x")).toThrow(/no such account/)
    })

    it("survives a re-sync for a workspace that's still a member", () => {
      describeWorkspace(SERVER, "u1", "Acme Co", "Client work.")
      setWorkspaces(SERVER, "u1", {
        ws_a: { name: "Personal", role: "owner" },
        ws_b: { name: "Acme Co", role: "owner" }, // role changed server-side, still present
      })
      expect(getAccount(SERVER, "u1").workspaces.ws_b).toEqual({
        name: "Acme Co",
        role: "owner",
        description: "Client work.",
      })
    })

    it("is dropped when the workspace is no longer in the synced roster", () => {
      describeWorkspace(SERVER, "u1", "Acme Co", "Client work.")
      setWorkspaces(SERVER, "u1", { ws_a: { name: "Personal", role: "owner" } }) // ws_b gone
      const diff = setWorkspaces(SERVER, "u1", {
        ws_a: { name: "Personal", role: "owner" },
        ws_b: { name: "Acme Co", role: "owner" }, // rejoins later, as a NEW membership
      })
      expect(diff.added).toEqual([{ id: "ws_b", name: "Acme Co" }])
      expect(getAccount(SERVER, "u1").workspaces.ws_b.description).toBeUndefined()
    })
  })

  describe("resolveWorkspaceRef (cross-account, for --workspace with no --account)", () => {
    beforeEach(() => {
      saveAccount(SERVER, "u1", { handle: "ava", grant: { token: "tok1" } })
      saveAccount(SERVER, "u2", { handle: "ava-work", grant: { token: "tok2" } })
      setWorkspaces(SERVER, "u1", { ws_a: { name: "Personal", role: "owner" } })
      setWorkspaces(SERVER, "u2", { ws_b: { name: "Client Org", role: "editor" } })
    })

    it("resolves an id match to the right account", () => {
      expect(resolveWorkspaceRef(SERVER, "ws_b")).toEqual({
        accountId: "u2",
        workspaceId: "ws_b",
        workspaceName: "Client Org",
      })
    })
    it("resolves a unique name match across accounts", () => {
      expect(resolveWorkspaceRef(SERVER, "client org")).toEqual({
        accountId: "u2",
        workspaceId: "ws_b",
        workspaceName: "Client Org",
      })
    })
    it("a shared workspace id under two accounts is not ambiguous — same workspace", () => {
      setWorkspaces(SERVER, "u2", {
        ws_b: { name: "Client Org", role: "editor" },
        ws_a: { name: "Personal", role: "viewer" }, // u2 also happens to share ws_a
      })
      const r = resolveWorkspaceRef(SERVER, "ws_a")
      expect(r.workspaceId).toBe("ws_a")
      expect(r.accountId).toBe("u1") // prefers the default account among the matches
    })
    it("flags a genuine name collision across two DIFFERENT workspaces as ambiguous", () => {
      setWorkspaces(SERVER, "u2", { ws_c: { name: "Personal", role: "owner" } }) // different id, same name as u1's
      const r = resolveWorkspaceRef(SERVER, "personal")
      expect(r.ambiguous).toEqual(
        expect.arrayContaining([
          { accountId: "u1", handle: "ava" },
          { accountId: "u2", handle: "ava-work" },
        ]),
      )
    })
    it("returns null when nothing matches", () => {
      expect(resolveWorkspaceRef(SERVER, "nope")).toBeNull()
    })
  })

  describe("resolvePublish target resolution", () => {
    beforeEach(() => {
      saveAccount(SERVER, "u1", { handle: "ava", grant: { token: "tok1" } })
      saveAccount(SERVER, "u2", { handle: "ava-work", grant: { token: "tok2" } })
      setWorkspaces(SERVER, "u1", {
        ws_a: { name: "Personal", role: "owner" },
        ws_b: { name: "Acme Co", role: "editor" },
      })
      setWorkspaces(SERVER, "u2", { ws_c: { name: "Client Org", role: "editor" } })
    })

    it("with no flags, resolves the stored default", () => {
      const r = resolvePublish({ server: SERVER }, null)
      expect(r).toMatchObject({
        accountId: "u1",
        accountHandle: "ava",
        workspaceId: "ws_a",
        workspaceName: "Personal",
        token: "tok1",
        workspaceError: null,
      })
    })

    it("--workspace alone resolves across accounts", () => {
      const r = resolvePublish({ server: SERVER, workspace: "Client Org" }, null)
      expect(r).toMatchObject({ accountId: "u2", workspaceId: "ws_c", token: "tok2" })
    })

    it("--account alone uses that account's own default workspace", () => {
      const r = resolvePublish({ server: SERVER, account: "ava-work" }, null)
      expect(r).toMatchObject({ accountId: "u2", workspaceId: "ws_c", token: "tok2" })
    })

    it("--workspace + --account together look up within that account only", () => {
      const r = resolvePublish({ server: SERVER, workspace: "Acme Co", account: "ava" }, null)
      expect(r).toMatchObject({ accountId: "u1", workspaceId: "ws_b" })
    })

    it("derive.json's workspace/account fields apply when no flag overrides them", () => {
      const r = resolvePublish({ server: SERVER }, { workspace: "ws_b", account: "ava" })
      expect(r).toMatchObject({ accountId: "u1", workspaceId: "ws_b" })
    })

    it("a flag wins over derive.json", () => {
      const r = resolvePublish({ server: SERVER, workspace: "ws_c" }, { workspace: "ws_b" })
      expect(r.workspaceId).toBe("ws_c")
    })

    it("an unknown --workspace surfaces workspaceError instead of throwing", () => {
      const r = resolvePublish({ server: SERVER, workspace: "Nope" }, null)
      expect(r.workspaceError).toEqual({ type: "not_found", ref: "Nope" })
      expect(r.workspaceId).toBeNull()
    })

    it("an unknown --account surfaces workspaceError", () => {
      const r = resolvePublish({ server: SERVER, account: "ghost" }, null)
      expect(r.workspaceError).toEqual({ type: "no_account", ref: "ghost" })
    })

    it("a name colliding across accounts surfaces an ambiguous workspaceError", () => {
      setWorkspaces(SERVER, "u2", { ws_d: { name: "Personal", role: "owner" } })
      const r = resolvePublish({ server: SERVER, workspace: "Personal" }, null)
      expect(r.workspaceError.type).toBe("ambiguous")
    })

    it("explicit --token and DERIVE_TOKEN still win over the resolved account token", () => {
      expect(resolvePublish({ server: SERVER, token: "tok_flag" }, null).token).toBe("tok_flag")
      process.env.DERIVE_TOKEN = "tok_env"
      expect(resolvePublish({ server: SERVER }, null).token).toBe("tok_env")
    })
  })

  describe("client id reuse", () => {
    it("is null until saved, then reused across logins", () => {
      expect(getClientId(SERVER)).toBeNull()
      saveClientId(SERVER, "client_123")
      expect(getClientId(SERVER)).toBe("client_123")
    })
  })

  describe("freshToken", () => {
    it("returns the saved token without a network call when still valid", async () => {
      saveAccount(SERVER, "u1", {
        grant: { token: "tok1", refresh_token: "r1", client_id: "c1", expires_in: 3600 },
      })
      const fetchSpy = vi.fn()
      vi.stubGlobal("fetch", fetchSpy)
      expect(await freshToken(SERVER, "u1")).toBe("tok1")
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it("refreshes and rotates when expired, persisting the new grant", async () => {
      saveAccount(SERVER, "u1", {
        grant: { token: "tok_old", refresh_token: "r_old", client_id: "c1", expires_in: -10 },
      })
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ access_token: "tok_new", refresh_token: "r_new", expires_in: 3600 }),
        }),
      )
      const token = await freshToken(SERVER, "u1")
      expect(token).toBe("tok_new")
      const account = getAccount(SERVER, "u1")
      expect(account.auth.token).toBe("tok_new")
      expect(account.auth.refresh_token).toBe("r_new")
    })

    it("falls back to the stale token if the refresh call fails", async () => {
      saveAccount(SERVER, "u1", {
        grant: { token: "tok_old", refresh_token: "r_old", client_id: "c1", expires_in: -10 },
      })
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")))
      expect(await freshToken(SERVER, "u1")).toBe("tok_old")
    })

    it("returns null for an unknown account", async () => {
      expect(await freshToken(SERVER, "ghost")).toBeNull()
      expect(await freshToken(SERVER, null)).toBeNull()
    })
  })
})

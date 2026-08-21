import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  agentScaffoldFiles,
  CONFIG_FILE,
  entryFor,
  findAccountWorkspace,
  forgetWorkspace,
  freshToken,
  getAccount,
  getDefault,
  listAccounts,
  loadConfig,
  mergeChosenWorkspaces,
  removeAccount,
  resolveAccountRef,
  resolvePublish,
  resolveWorkspaceRef,
  saveAccount,
  scaffold,
  scaffoldAgent,
  scaffoldFiles,
  setDefaultAccount,
  setDefaultWorkspace,
  setWorkspaces,
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
        "CLAUDE.md",
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
    for (const file of ["AGENTS.md", "CLAUDE.md"]) {
      const instructions = readFileSync(join(d, file), "utf8")
      expect(instructions).toContain("<!-- derive:artifact-first:start -->")
      expect(instructions).toContain("durable Derive artifact")
    }
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

    const skillPath = join(d, ".agents/skills/derive/SKILL.md")
    writeFileSync(skillPath, "locally changed\n")
    const stale = scaffoldAgent(d)
    expect(stale.outdated).toContain(".agents/skills/derive/SKILL.md")
    expect(readFileSync(skillPath, "utf8")).toBe("locally changed\n")

    const refreshed = scaffoldAgent(d, { update: true })
    expect(refreshed.updated).toContain(".agents/skills/derive/SKILL.md")
    expect(readFileSync(skillPath, "utf8")).toBe(
      agentScaffoldFiles()[".agents/skills/derive/SKILL.md"],
    )
    // Even explicit skill updates never replace project-owned MCP configuration.
    expect(refreshed.skipped).toContain(".mcp.json")
    expect(readFileSync(join(d, ".mcp.json"), "utf8")).toBe('{"mine":true}\n')
  })

  it("adds an idempotent managed preference to existing agent instruction files", () => {
    const d = tmp()
    writeFileSync(join(d, "AGENTS.md"), "# Existing agent rules\n\nKeep this.\n")
    writeFileSync(join(d, "CLAUDE.md"), "# Existing Claude rules\n\nKeep this too.")

    const first = scaffoldAgent(d)
    expect(first.updated).toEqual(expect.arrayContaining(["AGENTS.md", "CLAUDE.md"]))
    expect(readFileSync(join(d, "AGENTS.md"), "utf8")).toMatch(
      /^# Existing agent rules\n\nKeep this\.\n\n<!-- derive:artifact-first:start -->/,
    )
    expect(readFileSync(join(d, "CLAUDE.md"), "utf8")).toMatch(
      /^# Existing Claude rules\n\nKeep this too\.\n\n<!-- derive:artifact-first:start -->/,
    )

    const second = scaffoldAgent(d)
    expect(second.skipped).toEqual(expect.arrayContaining(["AGENTS.md", "CLAUDE.md"]))
    expect(
      readFileSync(join(d, "AGENTS.md"), "utf8").match(/derive:artifact-first:start/g),
    ).toHaveLength(1)
  })

  it("refreshes only Derive's marked instruction block with --update", () => {
    const d = tmp()
    scaffoldAgent(d)
    const path = join(d, "AGENTS.md")
    writeFileSync(path, readFileSync(path, "utf8").replace("Artifact-first handoff", "Old policy"))

    const kept = scaffoldAgent(d)
    expect(kept.outdated).toContain("AGENTS.md")
    expect(readFileSync(path, "utf8")).toContain("## Old policy")

    const refreshed = scaffoldAgent(d, { update: true })
    expect(refreshed.updated).toContain("AGENTS.md")
    expect(readFileSync(path, "utf8")).toContain("## Artifact-first handoff")
    expect(readFileSync(path, "utf8")).not.toContain("## Old policy")
  })

  it("never clobbers existing files", () => {
    const d = tmp()
    writeFileSync(join(d, CONFIG_FILE), '{"title":"mine","id":"keep"}')
    const { created, skipped } = scaffold(d, "X", "md")
    expect(skipped).toContain(CONFIG_FILE)
    expect(created).not.toContain(CONFIG_FILE)
    expect(JSON.parse(readFileSync(join(d, CONFIG_FILE), "utf8")).id).toBe("keep")
  })

  it("derive init adds the managed preference to existing instruction files", () => {
    const d = tmp()
    writeFileSync(join(d, "AGENTS.md"), "# My rules\n")
    const { updated, created } = scaffold(d, "X", "md")
    expect(updated).toContain("AGENTS.md")
    expect(created).toContain("CLAUDE.md")
    expect(readFileSync(join(d, "AGENTS.md"), "utf8")).toContain("# My rules")
    expect(readFileSync(join(d, "AGENTS.md"), "utf8")).toContain(
      "<!-- derive:artifact-first:start -->",
    )
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

describe("loadConfig", () => {
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
    it("resolves by handle, case-insensitively, with or without @", () => {
      expect(resolveAccountRef(SERVER, "ava")).toBe("u1")
      expect(resolveAccountRef(SERVER, "@ava")).toBe("u1")
      expect(resolveAccountRef(SERVER, "@AVA")).toBe("u1")
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

    it("removeAccount falls back the default to a remaining account", () => {
      expect(removeAccount(SERVER, "u1")).toBe(true)
      expect(getDefault(SERVER).account).toBe("u2")
      expect(listAccounts(SERVER)).toEqual([
        { id: "u2", handle: "bo", workspaceCount: 0, isDefault: true },
      ])
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
  })
})

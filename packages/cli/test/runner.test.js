import { execSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  buildPrompt,
  loadRunnerConfig,
  OUTPUT_CONTRACT,
  parseAnswer,
  parseManifest,
  renderServiceUnit,
  repoCatalogBlock,
  repoSlug,
  syncRepos,
} from "../src/runner.js"

describe("parseAnswer", () => {
  const good = `Here is my analysis.\n<answer>{"body_md":"32%","query":"select 1","confidence":0.9,"caveats":["small n"],"escalate":false,"escalation_reason":null}</answer>`

  it("extracts and validates a well-formed answer", () => {
    const { answer } = parseAnswer(good)
    expect(answer).toMatchObject({ body_md: "32%", confidence: 0.9, caveats: ["small n"] })
  })

  it("strips ```json fences inside the tags", () => {
    expect(parseAnswer('<answer>\n```json\n{"body_md":"ok"}\n```\n</answer>').answer.body_md).toBe(
      "ok",
    )
  })

  it("clamps confidence into [0,1] and defaults the optional fields", () => {
    const { answer } = parseAnswer('<answer>{"body_md":"x","confidence":7}</answer>')
    expect(answer).toMatchObject({ confidence: 1, query: null, caveats: [], escalate: false })
  })

  it("rejects a missing block, bad JSON, and an empty body", () => {
    expect(parseAnswer("no block here").error).toMatch(/no <answer>/)
    expect(parseAnswer("<answer>{nope}</answer>").error).toMatch(/parse/)
    expect(parseAnswer('<answer>{"body_md":"  "}</answer>').error).toMatch(/body_md/)
  })

  it("carries escalation through", () => {
    const { answer } = parseAnswer(
      '<answer>{"body_md":"draft","escalate":true,"escalation_reason":"pricing"}</answer>',
    )
    expect(answer).toMatchObject({ escalate: true, escalation_reason: "pricing" })
  })

  it("accepts a well-formed artifact; malformed/oversized/blank ones demote to null", () => {
    const ok = parseAnswer(
      '<answer>{"body_md":"chart below","artifact":{"title":"Orgs by provider","html":"<!doctype html><svg></svg>"}}</answer>',
    )
    expect(ok.answer.artifact).toMatchObject({ title: "Orgs by provider" })
    expect(
      parseAnswer('<answer>{"body_md":"x","artifact":{"title":"t"}}</answer>').answer.artifact,
    ).toBeNull()
    expect(
      parseAnswer('<answer>{"body_md":"x","artifact":{"title":" ","html":"<p>"}}</answer>').answer
        .artifact,
    ).toBeNull()
    const huge = JSON.stringify({
      body_md: "x",
      artifact: { title: "t", html: "a".repeat(2_000_001) },
    })
    expect(parseAnswer(`<answer>${huge}</answer>`).answer.artifact).toBeNull()
    // Model-generated titles are clamped to card width.
    const long = JSON.stringify({
      body_md: "x",
      artifact: { title: "t".repeat(300), html: "<p>x</p>" },
    })
    expect(parseAnswer(`<answer>${long}</answer>`).answer.artifact.title).toHaveLength(120)
  })
})

describe("buildPrompt", () => {
  it("replays the transcript with roles and points at the latest ASKER message", () => {
    const p = buildPrompt([
      { author_kind: "asker", body_md: "churn?" },
      { author_kind: "agent", body_md: "32%" },
      { author_kind: "asker", body_md: "and feb?" },
    ])
    expect(p).toContain("[asker] churn?")
    expect(p).toContain("[you] 32%")
    expect(p).toContain("Answer the asker's latest message")
  })
})

describe("loadRunnerConfig", () => {
  it("requires a token and context; flags win over env", () => {
    expect(() => loadRunnerConfig({}, {})).toThrow(/required/)
    const cfg = loadRunnerConfig(
      { DERIVE_TOKEN: "env-tok", DERIVE_CONTEXT: "ctx_env", RUNNER_MODEL: "opus" },
      { context: "ctx_flag", model: "sonnet" },
    )
    expect(cfg.contextId).toBe("ctx_flag")
    expect(cfg.model).toBe("sonnet")
    expect(cfg.token).toBe("env-tok")
    expect(cfg.server).toBe("https://derive.to") // cloud default
  })

  it("reads the token from --token-file (whitespace-stripped)", () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-test-"))
    const f = join(dir, "tok")
    writeFileSync(f, "  dk_agt_abc\n")
    const cfg = loadRunnerConfig({}, { "token-file": f, context: "ctx_x" })
    expect(cfg.token).toBe("dk_agt_abc")
  })

  it("floors malformed poll/timeout values instead of passing NaN to setTimeout", () => {
    const cfg = loadRunnerConfig(
      { DERIVE_TOKEN: "t", DERIVE_CONTEXT: "ctx_x", RUNNER_POLL_MS: "5s", RUNNER_TIMEOUT_MS: "-1" },
      {},
    )
    expect(cfg.pollMs).toBe(5_000)
    expect(cfg.timeoutMs).toBe(600_000)
  })

  it("--env-file values override ambient env (source semantics), applied to the given env only", () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-test-"))
    const f = join(dir, ".env")
    writeFileSync(f, `# comment\nexport DERIVE_TOKEN="fresh"\nSNOWFLAKE_KEY='s3cr3t'\n`)
    const env = { DERIVE_TOKEN: "stale-exported" }
    const cfg = loadRunnerConfig(env, { "env-file": f, context: "ctx_x" })
    expect(cfg.token).toBe("fresh")
    expect(env.SNOWFLAKE_KEY).toBe("s3cr3t")
    expect(process.env.SNOWFLAKE_KEY).toBeUndefined()
  })

  it("a missing env file names the flag, not just the errno", () => {
    expect(() =>
      loadRunnerConfig({ DERIVE_TOKEN: "t" }, { "env-file": "/nope/.env", context: "ctx_x" }),
    ).toThrow(/--env-file \/nope\/\.env/)
  })

  it("partial mode (doctor) tolerates missing token/context", () => {
    const cfg = loadRunnerConfig({}, {}, { partial: true })
    expect(cfg.token).toBe("")
    expect(cfg.contextId).toBe("")
  })

  it("carries --manifest-file (dev mode) into the config", () => {
    const cfg = loadRunnerConfig(
      { DERIVE_TOKEN: "t" },
      { context: "ctx_x", "manifest-file": "/work/context/MANIFEST.md" },
    )
    expect(cfg.manifestFile).toBe("/work/context/MANIFEST.md")
  })
})

describe("repo pointers", () => {
  it("parses repos out of frontmatter and strips it from the prompt body", () => {
    const md = `---
repos:
  - url: https://github.com/churnkey/churnkey-labs
    ref: main
    description: "the eda corpus"
  - url: git@github.com:acme/private-notes.git
other_key: ignored
---

# The manifest body`
    const { body, repos } = parseManifest(md)
    expect(body).toBe("\n# The manifest body")
    expect(repos).toEqual([
      {
        url: "https://github.com/churnkey/churnkey-labs",
        ref: "main",
        description: "the eda corpus",
      },
      { url: "git@github.com:acme/private-notes.git", ref: null, description: "" },
    ])
  })

  it("passes a manifest without frontmatter through untouched", () => {
    expect(parseManifest("# Plain")).toEqual({ body: "# Plain", repos: [] })
  })

  it("the scaffolded example stays inert (commented) and junk urls are dropped", () => {
    const commented = "---\n# repos:\n#   - url: https://github.com/you/x\n---\nbody"
    expect(parseManifest(commented).repos).toEqual([])
    const junk = "---\nrepos:\n  - url: not-a-url\n---\nbody"
    expect(parseManifest(junk).repos).toEqual([])
  })

  it("slugs are owner-repo so same-named repos from different owners don't collide", () => {
    expect(repoSlug("https://github.com/churnkey/eda")).toBe("churnkey-eda")
    expect(repoSlug("https://github.com/acme/eda.git")).toBe("acme-eda")
    expect(repoSlug("git@github.com:acme/eda.git")).toBe("acme-eda")
  })

  it("the catalog block names what's on disk and states what isn't", () => {
    expect(repoCatalogBlock([])).toBe("")
    const block = repoCatalogBlock([
      { url: "https://github.com/a/ok", ref: "main", description: "docs", sha: "ab12cd34ef56" },
      { url: "https://github.com/a/gone", ref: null, description: "", sha: null },
    ])
    expect(block).toContain("repos/a-ok — docs (main @ ab12cd34ef56)")
    expect(block).toContain("repos/a-gone")
    expect(block).toContain("UNAVAILABLE")
  })

  it("syncRepos clones at boot and follows the tip on the next boot", async () => {
    const src = mkdtempSync(join(tmpdir(), "runner-repo-src-"))
    const cwd = mkdtempSync(join(tmpdir(), "runner-repo-cwd-"))
    const sh = (cmd) => execSync(cmd, { cwd: src, stdio: "pipe" })
    sh("git init -q -b main && git config user.email t@t && git config user.name t")
    writeFileSync(join(src, "notes.md"), "v1")
    sh("git add . && git commit -qm one")
    const repos = [{ url: `file://${src}`, ref: "main", description: "notes" }]

    const first = await syncRepos(repos, cwd)
    expect(first[0].sha).toMatch(/^[0-9a-f]{12}$/)
    expect(readFileSync(join(cwd, "repos", repoSlug(repos[0].url), "notes.md"), "utf8")).toBe("v1")

    writeFileSync(join(src, "notes.md"), "v2")
    sh("git add . && git commit -qm two")
    const second = await syncRepos(repos, cwd)
    expect(second[0].sha).not.toBe(first[0].sha)
    expect(readFileSync(join(cwd, "repos", repoSlug(repos[0].url), "notes.md"), "utf8")).toBe("v2")
  }, 30_000)

  it("a dead pointer is loud but non-fatal: catalog entry with sha null", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "runner-repo-cwd-"))
    const out = await syncRepos(
      [{ url: "file:///nonexistent/repo", ref: null, description: "" }],
      cwd,
    )
    expect(out).toHaveLength(1)
    expect(out[0].sha).toBeNull()
  }, 30_000)
})

describe("output contract + service units", () => {
  it("the parse anchor comes from the runner, not the author-editable manifest", () => {
    expect(OUTPUT_CONTRACT).toContain("<answer>")
    expect(OUTPUT_CONTRACT).toContain("body_md")
  })

  it("renders units that reproduce the FULL running config (nothing silently dropped)", () => {
    const cfg = loadRunnerConfig(
      { RUNNER_TIMEOUT_MS: "2400000" },
      { context: "ctx_abc", token: "t", cwd: "/work", "claude-bin": "/usr/local/bin/claude" },
    )
    cfg.tokenFile = "/secrets/tok"
    cfg.envFiles = ["/work/.env", "/work/extra.env"]
    cfg.manifestFile = "/work/context/MANIFEST.md"
    const mac = renderServiceUnit(cfg, "/opt/cli/bin/derive.js", "darwin")
    expect(mac.unit).toContain("<string>ctx_abc</string>")
    expect(mac.unit).toContain("<string>--token-file</string>")
    expect(mac.unit).toContain("<string>/work/.env,/work/extra.env</string>")
    expect(mac.unit).toContain("<string>2400000</string>") // timeout survives into the unit
    expect(mac.unit).toContain("<string>--manifest-file</string>")
    expect(mac.path).toContain("to.derive.runner.abc")
    const linux = renderServiceUnit(cfg, "/opt/cli/bin/derive.js", "linux")
    expect(linux.unit).toContain("ExecStart=")
    expect(linux.unit).toContain("runner serve ctx_abc")
    expect(linux.unit).toContain("--env-file /work/.env,/work/extra.env")
    expect(linux.unit).toContain("Restart=on-failure")
  })

  it("escapes hostile paths: XML entities in plists, %/space/quote for systemd", () => {
    const cfg = loadRunnerConfig(
      {},
      { context: "ctx_abc", token: "t", cwd: "/Users/rob/R&D <100%> dir" },
    )
    const mac = renderServiceUnit(cfg, "/opt/cli/bin/derive.js", "darwin")
    expect(mac.unit).toContain("<string>/Users/rob/R&amp;D &lt;100%&gt; dir</string>")
    const linux = renderServiceUnit(cfg, "/opt/cli/bin/derive.js", "linux")
    expect(linux.unit).toContain('"/Users/rob/R&D <100%%> dir"')
  })
})

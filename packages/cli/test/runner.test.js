import { execSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  buildPrompt,
  loadRunnerConfig,
  OUTPUT_CONTRACT,
  once,
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
  - url: https://github.com/octo-org/octo-labs
    ref: main
    description: "the eda corpus"
  - url: git@github.com:acme/private-notes.git
other_key: ignored
---

# The manifest body`
    const { body, repos, skills, brandprint } = parseManifest(md)
    expect(body).toBe("\n# The manifest body")
    expect(skills).toEqual([])
    expect(brandprint).toBe("live")
    expect(repos).toEqual([
      {
        url: "https://github.com/octo-org/octo-labs",
        ref: "main",
        description: "the eda corpus",
      },
      { url: "git@github.com:acme/private-notes.git", ref: null, description: "" },
    ])
  })

  it("passes a manifest without frontmatter through untouched", () => {
    expect(parseManifest("# Plain")).toEqual({
      body: "# Plain",
      repos: [],
      skills: [],
      brandprint: "live",
    })
  })

  it("the scaffolded example stays inert (commented) and junk urls are dropped", () => {
    const commented = "---\n# repos:\n#   - url: https://github.com/you/x\n---\nbody"
    expect(parseManifest(commented).repos).toEqual([])
    const junk = "---\nrepos:\n  - url: not-a-url\n---\nbody"
    expect(parseManifest(junk).repos).toEqual([])
  })

  it("parses a pinned skills list and the brandprint opt-out alongside repos", () => {
    const md = `---
repos:
  - url: https://github.com/acme/warehouse
skills:
  - id: x7km2p4q
    version: 3
  - id: j9rw8n2v
brandprint: off
---

# Body`
    const { skills, brandprint, repos } = parseManifest(md)
    expect(repos).toHaveLength(1)
    expect(skills).toEqual([
      { id: "x7km2p4q", version: 3 },
      { id: "j9rw8n2v", version: null }, // unpinned until push resolves it
    ])
    expect(brandprint).toBe("off")
  })

  it("brandprint defaults to live when the scalar is absent", () => {
    expect(parseManifest("---\nskills:\n  - id: a1b2c3d4\n    version: 1\n---\nx").brandprint).toBe(
      "live",
    )
  })

  it("slugs are owner-repo so same-named repos from different owners don't collide", () => {
    expect(repoSlug("https://github.com/octo-org/eda")).toBe("octo-org-eda")
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

  it("the contract hammers the two things that failed in the field", () => {
    // A model deep in a build forgot the block and wrote the artifact to a file.
    expect(OUTPUT_CONTRACT).toMatch(/FINAL message MUST END/i)
    expect(OUTPUT_CONTRACT).toMatch(/do NOT write it to a file/i)
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

describe("runner once (single drain)", () => {
  // A real HTTP stub of the four routes the drain touches, so `once` is tested
  // over the wire it actually speaks — mock mode skips only the model.
  const startStub = async ({ failAnswerFor = [], contextStatus = 200 } = {}) => {
    const calls = []
    const sessions = [
      { id: "s1", messages: [{ id: "m1", author_kind: "asker", body_md: "hello?" }] },
      // Settled: last turn is a non-stale agent answer — must be skipped.
      {
        id: "s2",
        messages: [
          { id: "m2", author_kind: "asker", body_md: "old" },
          { id: "m3", author_kind: "agent", body_md: "done", meta: {} },
        ],
      },
      // Stale re-serve: the server marked the answer stale mid-run — must be served.
      {
        id: "s3",
        messages: [
          { id: "m4", author_kind: "asker", body_md: "follow-up" },
          { id: "m5", author_kind: "agent", body_md: "old answer", meta: { stale: true } },
        ],
      },
    ]
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, "http://stub")
      calls.push(`${req.method} ${url.pathname}`)
      const json = (o, status = 200) => {
        res.statusCode = status
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify(o))
      }
      if (url.pathname === "/v1/contexts/ctx1")
        return json(
          contextStatus === 200
            ? { name: "T", manifest_md: "Answer briefly.", manifest_version: 3, brandprint: null }
            : { error: "nope" },
          contextStatus,
        )
      if (url.pathname === "/v1/contexts/ctx1/queue") return json({ sessions })
      const post = url.pathname.match(/^\/v1\/sessions\/(\w+)\/messages$/)
      if (req.method === "POST" && post)
        return json(
          { ok: !failAnswerFor.includes(post[1]) },
          failAnswerFor.includes(post[1]) ? 500 : 200,
        )
      if (req.method === "PATCH" && url.pathname.startsWith("/v1/sessions/"))
        return json({ ok: true })
      json({ error: "unexpected" }, 404)
    })
    await new Promise((r) => srv.listen(0, "127.0.0.1", r))
    return { srv, calls, port: srv.address().port }
  }

  const cfgFor = (port) =>
    loadRunnerConfig(
      {
        DERIVE_SERVER: `http://127.0.0.1:${port}`,
        DERIVE_TOKEN: "t",
        DERIVE_CONTEXT: "ctx1",
        RUNNER_MOCK: "1",
        RUNNER_CWD: mkdtempSync(join(tmpdir(), "runner-once-")),
      },
      {},
    )

  it("serves the open and stale sessions, skips the settled one, and reports counts", async () => {
    const { srv, calls, port } = await startStub()
    try {
      const counts = await once(cfgFor(port))
      expect(counts).toEqual({ considered: 2, served: 2, failed: 0 })
      expect(calls.filter((c) => c === "POST /v1/sessions/s1/messages")).toHaveLength(1)
      expect(calls.filter((c) => c === "POST /v1/sessions/s3/messages")).toHaveLength(1)
      expect(calls.some((c) => c.includes("/v1/sessions/s2/"))).toBe(false)
    } finally {
      srv.close()
    }
  })

  it("a failed answer post counts as failed without aborting the rest of the drain", async () => {
    const { srv, calls, port } = await startStub({ failAnswerFor: ["s1"] })
    try {
      const counts = await once(cfgFor(port))
      expect(counts).toEqual({ considered: 2, served: 1, failed: 1 })
      // The failure did not starve s3 — the batch kept going.
      expect(calls.filter((c) => c === "POST /v1/sessions/s3/messages")).toHaveLength(1)
    } finally {
      srv.close()
    }
  })

  it("a boot failure throws (the scheduler's retry is the retry)", async () => {
    const { srv, port } = await startStub({ contextStatus: 500 })
    try {
      await expect(once(cfgFor(port))).rejects.toThrow(/contexts\/ctx1/)
    } finally {
      srv.close()
    }
  })
})

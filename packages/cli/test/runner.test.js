import { execSync } from "node:child_process"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  buildPrompt,
  checkWritable,
  doctor,
  loadRunnerConfig,
  OUTPUT_CONTRACT,
  once,
  parseAnswer,
  parseManifest,
  RETRY_DELAY_MS,
  renderServiceUnit,
  repoCatalogBlock,
  repoSlug,
  resolveArtifactHtml,
  runClaude,
  serveSession,
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

  it("an unwritable cwd is non-fatal too — it must not crash-loop serve at boot", async () => {
    // The field failure: a bind-mounted /work owned by the host uid, cloned into
    // by a container running as a different one. The mkdir threw and, unlike a
    // failed clone, took the whole daemon down under restart:unless-stopped.
    const cwd = mkdtempSync(join(tmpdir(), "runner-ro-cwd-"))
    chmodSync(cwd, 0o555)
    try {
      const out = await syncRepos([{ url: "file:///some/repo", ref: null, description: "" }], cwd)
      expect(out).toHaveLength(1)
      expect(out[0].sha).toBeNull()
    } finally {
      chmodSync(cwd, 0o755)
    }
  }, 30_000)

  it("checkWritable tells a writable dir from one the runner only has read access to", () => {
    const cwd = mkdtempSync(join(tmpdir(), "runner-probe-"))
    expect(checkWritable(cwd)).toBeNull()
    chmodSync(cwd, 0o555)
    try {
      expect(checkWritable(cwd)).toMatch(/EACCES|permission/i)
    } finally {
      chmodSync(cwd, 0o755)
    }
    // A missing dir reports rather than throws — doctor prints, it doesn't crash.
    expect(checkWritable(join(cwd, "nope"))).toBeTruthy()
  })
})

describe("artifact file channel", () => {
  it("parseAnswer accepts a path artifact, and inline html still wins", () => {
    const byPath = parseAnswer(
      '<answer>{"body_md":"page below","artifact":{"title":"Companion","path":"companion.html"}}</answer>',
    )
    expect(byPath.answer.artifact).toEqual({ title: "Companion", path: "companion.html" })
    const inline = parseAnswer(
      '<answer>{"body_md":"x","artifact":{"title":"t","html":"<p>hi</p>","path":"x.html"}}</answer>',
    )
    expect(inline.answer.artifact).toMatchObject({ html: "<p>hi</p>" })
    // Neither channel filled is still nothing to publish.
    expect(
      parseAnswer('<answer>{"body_md":"x","artifact":{"title":"t","path":"  "}}</answer>').answer
        .artifact,
    ).toBeNull()
    // Oversized inline WITH a path falls back to the file — the exact case that
    // made a 107KB companion page unrecoverable.
    const both = JSON.stringify({
      body_md: "x",
      artifact: { title: "t", html: "a".repeat(2_000_001), path: "big.html" },
    })
    expect(parseAnswer(`<answer>${both}</answer>`).answer.artifact).toEqual({
      title: "t",
      path: "big.html",
    })
  })

  it("resolves a relative path under cwd and refuses to leave it", () => {
    const cwd = mkdtempSync(join(tmpdir(), "runner-art-"))
    mkdirSync(join(cwd, "out"))
    writeFileSync(join(cwd, "out", "page.html"), "<!doctype html><p>hi</p>")
    expect(resolveArtifactHtml({ title: "t", path: "out/page.html" }, cwd).html).toContain(
      "<p>hi</p>",
    )
    // Inline artifacts pass straight through — no filesystem involved.
    expect(resolveArtifactHtml({ title: "t", html: "<b>x</b>" }, cwd).html).toBe("<b>x</b>")
    // Escapes and misses report, never publish. Publishing an arbitrary host
    // file into a workspace artifact would be a real leak.
    const elsewhere = mkdtempSync(join(tmpdir(), "runner-elsewhere-"))
    writeFileSync(join(elsewhere, "secret.html"), "<p>not yours</p>")
    expect(
      resolveArtifactHtml({ title: "t", path: join(elsewhere, "secret.html") }, cwd).error,
    ).toMatch(/outside/)
    expect(
      resolveArtifactHtml({ title: "t", path: `../${basename(elsewhere)}/secret.html` }, cwd).error,
    ).toMatch(/outside/)
    // A symlink the model itself plants inside cwd is still an escape.
    symlinkSync(join(elsewhere, "secret.html"), join(cwd, "link.html"))
    expect(resolveArtifactHtml({ title: "t", path: "link.html" }, cwd).error).toMatch(/outside/)
    expect(resolveArtifactHtml({ title: "t", path: "missing.html" }, cwd).error).toMatch(/read/i)
    writeFileSync(join(cwd, "empty.html"), "   ")
    expect(resolveArtifactHtml({ title: "t", path: "empty.html" }, cwd).error).toMatch(/empty/)
    writeFileSync(join(cwd, "huge.html"), "a".repeat(2_000_001))
    expect(resolveArtifactHtml({ title: "t", path: "huge.html" }, cwd).error).toMatch(/cap/)
  })

  it("only publishes a regular .html file — a FIFO would wedge the poll loop forever", () => {
    const cwd = mkdtempSync(join(tmpdir(), "runner-art-guard-"))
    // The path names the PAGE the model built. This is not a confidentiality
    // boundary — a model with shell in cwd can `cp .env page.html` — but it
    // stops the zero-effort form, where one innocuous-looking field points
    // straight at the runner's own credentials (cwd/.env on the prod host).
    writeFileSync(join(cwd, ".env"), "DERIVE_TOKEN=dk_secret\nMONGO_URI=mongodb://x")
    expect(resolveArtifactHtml({ title: "t", path: ".env" }, cwd).error).toMatch(/\.html/)
    mkdirSync(join(cwd, "dir.html"))
    expect(resolveArtifactHtml({ title: "t", path: "dir.html" }, cwd).error).toBeTruthy()
    // readFileSync on a FIFO blocks the event loop with no timeout: the daemon
    // stays "up" under restart:unless-stopped while answering nothing, ever.
    execSync(`mkfifo ${join(cwd, "pipe.html")}`)
    expect(resolveArtifactHtml({ title: "t", path: "pipe.html" }, cwd).error).toMatch(
      /not a regular file/,
    )
  })

  it("serveSession publishes the file's bytes, and a bad path is a caveat not a dead session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "runner-serve-"))
    writeFileSync(join(cwd, "page.html"), "<!doctype html><h1>companion</h1>")
    const calls = { published: [], answered: [], failed: [] }
    const client = {
      publishArtifact: async (title, html) => {
        calls.published.push({ title, html })
        return { short_id: "art123" }
      },
      answer: async (id, body, meta, state) => calls.answered.push({ id, body, meta, state }),
      fail: async (id) => calls.failed.push(id),
    }
    const session = () => ({
      id: "ses_1",
      messages: [{ id: "m1", author_kind: "asker", body_md: "build me a page" }],
    })
    const cfg = { cwd, mock: false }
    // A fake `claude` that just emits the block, so the artifact channel runs
    // end to end — parse → resolve from disk → publish → answer.
    const fake = (answerJson) => {
      const dir = mkdtempSync(join(tmpdir(), "runner-fake-"))
      const bin = join(dir, "claude")
      writeFileSync(
        bin,
        `#!/bin/sh\ncat <<'EOF'\n{"type":"result","result":"<answer>${answerJson}</answer>"}\nEOF\n`,
      )
      chmodSync(bin, 0o755)
      return bin
    }
    const base = { ...cfg, model: "sonnet", timeoutMs: 30_000 }

    await serveSession(
      client,
      session(),
      "manifest",
      {
        ...base,
        agentBin: fake(
          '{\\"body_md\\":\\"page built\\",\\"artifact\\":{\\"title\\":\\"Companion\\",\\"path\\":\\"page.html\\"}}',
        ),
      },
      [],
      [],
    )
    expect(calls.published[0]).toMatchObject({ title: "Companion" })
    expect(calls.published[0].html).toContain("<h1>companion</h1>") // the FILE's bytes
    expect(calls.answered[0].meta.artifacts).toEqual([{ short_id: "art123", title: "Companion" }])

    await serveSession(
      client,
      session(),
      "manifest",
      {
        ...base,
        agentBin: fake(
          '{\\"body_md\\":\\"page built\\",\\"artifact\\":{\\"title\\":\\"Gone\\",\\"path\\":\\"nope.html\\"}}',
        ),
      },
      [],
      [],
    )
    expect(calls.published).toHaveLength(1) // nothing published for the missing file
    expect(calls.failed).toHaveLength(0) // and the session still answered
    expect(calls.answered[1].state).toBe("answered")
    expect(calls.answered[1].meta.caveats.join(" ")).toMatch(/nope\.html/)
  }, 30_000)
})

describe("runClaude transient-failure retry", () => {
  /** A stub `claude` that records each invocation's argv and replays canned
   *  stream-json. `script` is sh run per invocation with $n = attempt number. */
  const fakeClaude = (body) => {
    const dir = mkdtempSync(join(tmpdir(), "runner-fake-claude-"))
    const bin = join(dir, "claude")
    writeFileSync(
      bin,
      `#!/bin/sh
d="${dir}"
n=$(cat "$d/count" 2>/dev/null || echo 0)
n=$((n+1))
echo $n > "$d/count"
printf '%s\\n' "$@" > "$d/args.$n"
${body}
`,
    )
    chmodSync(bin, 0o755)
    return {
      bin,
      attempts: () => Number(readFileSync(join(dir, "count"), "utf8").trim()),
      args: (n) => readFileSync(join(dir, `args.${n}`), "utf8"),
    }
  }
  const opts = (bin) => ({
    bin,
    cwd: tmpdir(),
    model: "sonnet",
    timeoutMs: 30_000,
    systemPrompt: "you are a runner",
    prompt: "how many orgs?",
    retryDelayMs: 0,
  })

  // The shape below is COPIED FROM THE REAL CLI (v2.1.216): an API failure is a
  // `result` event with is_error + api_error_status and a POPULATED `result`
  // string. Assuming it exited silently is exactly the mistake that made the
  // first cut of this retry inert for the failure it was written for.
  const apiError = (status, msg) =>
    `echo '{"type":"result","subtype":"success","is_error":true,"api_error_status":${status},"result":"${msg}","session_id":"sess-abc"}'\nexit 1`

  it("resumes the session after a transient API error instead of losing the run", async () => {
    // The field failure: `API Error: 529 Overloaded` five minutes into a review.
    const fake = fakeClaude(`
if [ "$n" = 1 ]; then
  echo '{"type":"system","session_id":"sess-abc"}'
  ${apiError(529, "API Error: 529 Overloaded")}
fi
echo '{"type":"result","result":"<answer>{\\"body_md\\":\\"32%\\"}</answer>"}'
`)
    const out = await runClaude(opts(fake.bin))
    expect(out.ok).toBe(true)
    expect(out.answer.body_md).toBe("32%")
    expect(fake.attempts()).toBe(2)
    // Resumed, not restarted: the five minutes of work already done survives.
    expect(fake.args(2)).toContain("--resume")
    expect(fake.args(2)).toContain("sess-abc")
  }, 30_000)

  it("does NOT retry a 4xx — a wrong model name fails identically twice", async () => {
    // Real capture: `--model bogus-model-xyz` → api_error_status 404, exit 1.
    const fake = fakeClaude(
      apiError(404, "There is an issue with the selected model (bogus-model-xyz)."),
    )
    const out = await runClaude(opts(fake.bin))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/selected model/)
    expect(fake.attempts()).toBe(1) // no sleep, no second spawn
  }, 30_000)

  it("does NOT retry a spawn failure — a missing binary is not a busy service", async () => {
    const out = await runClaude(opts("/nonexistent/claude"))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/ENOENT/)
  }, 30_000)

  it("an error run is never salvaged — the asker must not get 'API Error: 529' as an answer", async () => {
    const fake = fakeClaude(apiError(529, "API Error: 529 Overloaded"))
    const out = await runClaude(opts(fake.bin))
    expect(out.ok).toBe(false)
    expect(out.error).toContain("529")
    expect(fake.attempts()).toBe(2) // bounded at one retry
  }, 30_000)

  it("takes a valid block even when the process exits nonzero after emitting it", async () => {
    const fake = fakeClaude(`
echo '{"type":"result","result":"<answer>{\\"body_md\\":\\"the work got done\\"}</answer>"}'
exit 1
`)
    const out = await runClaude(opts(fake.bin))
    expect(out.ok).toBe(true)
    expect(out.answer.body_md).toBe("the work got done")
  }, 30_000)

  it("does NOT retry a timeout — that's the owner's signal, not a busy service", async () => {
    const fake = fakeClaude(`sleep 10`)
    const out = await runClaude({ ...opts(fake.bin), timeoutMs: 1_000 })
    expect(out.ok).toBe(false)
    expect(out.error).toBe("timed out")
    expect(fake.attempts()).toBe(1)
  }, 30_000)

  it("re-sends the system prompt on every resume — --resume does not carry it", async () => {
    // Verified against the real CLI: a turn started with --resume runs WITHOUT
    // the original --append-system-prompt. Without this, the retry and the nudge
    // both judge the model against a contract it can no longer see.
    const fake = fakeClaude(`
if [ "$n" = 1 ]; then
  echo '{"type":"system","session_id":"sess-abc"}'
  ${apiError(529, "API Error: 529 Overloaded")}
fi
echo '{"type":"result","result":"<answer>{\\"body_md\\":\\"ok\\"}</answer>"}'
`)
    await runClaude(opts(fake.bin))
    expect(fake.args(2)).toContain("--resume")
    expect(fake.args(2)).toContain("--append-system-prompt")
    expect(fake.args(2)).toContain("you are a runner") // the manifest
    expect(fake.args(2)).toContain("<answer>") // and the output contract
  }, 30_000)

  it("the nudge carries the system prompt too", async () => {
    const fake = fakeClaude(`
echo '{"type":"system","session_id":"sess-x"}'
echo '{"type":"result","result":"prose, no block"}'
`)
    await runClaude(opts(fake.bin))
    expect(fake.args(2)).toContain("--resume")
    expect(fake.args(2)).toContain("--append-system-prompt")
  }, 30_000)

  it("waits before retrying, and the default wait clears the CLI's own backoff", async () => {
    // Two halves, so neither costs 30s of CI: the delay is really awaited...
    const fake = fakeClaude(apiError(503, "overloaded"))
    const started = Date.now()
    await runClaude({ ...opts(fake.bin), retryDelayMs: 1_000 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000)
    expect(fake.attempts()).toBe(2)
    // ...and the production default (every other test overrides it to 0) is long
    // enough not to land inside the overload window the CLI just gave up on.
    expect(RETRY_DELAY_MS).toBeGreaterThanOrEqual(20_000)
  }, 30_000)

  it("retries from scratch when the run died before a session id existed", async () => {
    const fake = fakeClaude(`
if [ "$n" = 1 ]; then exit 1; fi
echo '{"type":"result","result":"<answer>{\\"body_md\\":\\"ok\\"}</answer>"}'
`)
    const out = await runClaude(opts(fake.bin))
    expect(out.ok).toBe(true)
    expect(fake.args(2)).not.toContain("--resume")
    expect(fake.args(2)).toContain("how many orgs?")
  }, 30_000)

  it("does NOT retry a run that produced output — that's the nudge/salvage path", async () => {
    const fake = fakeClaude(`
echo '{"type":"system","session_id":"sess-x"}'
echo '{"type":"result","result":"here is prose but no block"}'
`)
    const out = await runClaude(opts(fake.bin))
    expect(out.ok).toBe(true) // salvaged
    expect(out.answer.body_md).toBe("here is prose but no block")
    expect(fake.attempts()).toBe(2) // the original run + the nudge, not a retry
    expect(fake.args(2)).toContain("--resume")
  }, 30_000)
})

describe("doctor", () => {
  // The point of the writability check is that DOCTOR reports it — testing
  // checkWritable alone leaves the actual fix (and the field regression it
  // exists for: doctor green while serve crash-looped) free to be reverted.
  const runDoctor = async (cfg) => {
    const lines = []
    const spy =
      (m) =>
      (...a) => {
        lines.push(a.join(" "))
        return m
      }
    const orig = [console.log, console.error, console.warn]
    console.log = spy()
    console.error = spy()
    console.warn = spy()
    try {
      const failures = await doctor({
        server: "http://127.0.0.1:9",
        token: "",
        contextId: "",
        agentBin: "/nonexistent/claude",
        providerName: "claude-code",
        ...cfg,
      })
      return { failures, out: lines.join("\n") }
    } finally {
      ;[console.log, console.error, console.warn] = orig
    }
  }

  it.skipIf(process.getuid?.() === 0)(
    "fails on a cwd it cannot write, and says why",
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "runner-doctor-"))
      const before = await runDoctor({ cwd })
      expect(before.out).toContain("(writable)")

      chmodSync(cwd, 0o555)
      try {
        const after = await runDoctor({ cwd })
        expect(after.out).toMatch(/cwd writable/)
        expect(after.out).toMatch(/uid/) // names the bind-mount cause
        // Without a manifest there are no repos or skills to materialize, so an
        // unwritable cwd is survivable — a warning, not a refusal to start.
        expect(after.failures).toBe(before.failures)
      } finally {
        chmodSync(cwd, 0o755)
      }
    },
    60_000,
  )

  it("leaves no probe directory behind", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "runner-doctor-"))
    await runDoctor({ cwd })
    await runDoctor({ cwd })
    expect(readdirSync(cwd)).toEqual([])
  }, 60_000)
})

describe("output contract + service units", () => {
  it("the parse anchor comes from the runner, not the author-editable manifest", () => {
    expect(OUTPUT_CONTRACT).toContain("<answer>")
    expect(OUTPUT_CONTRACT).toContain("body_md")
  })

  it("the contract still demands the block, and no longer forbids the file channel", () => {
    // Weak by nature — it greps a prompt — so it asserts only the two things a
    // future edit could silently invert. The block is still mandatory...
    expect(OUTPUT_CONTRACT).toMatch(/FINAL message MUST END/i)
    // ...and the old "do NOT write it to a file" rule is GONE: it was what made
    // a 107KB page unrecoverable, since re-emitting it inline never fit.
    expect(OUTPUT_CONTRACT).not.toMatch(/do NOT write it to a file/i)
    expect(
      parseAnswer('<answer>{"body_md":"x","artifact":{"title":"t","path":"p.html"}}</answer>')
        .answer.artifact,
    ).toEqual({ title: "t", path: "p.html" })
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

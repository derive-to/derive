import { execSync, spawn, spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"
import { loadJobRunnerConfig } from "../src/job-runner.js"
import { claudeCode } from "../src/providers/claude-code.js"
import { prepareRepo } from "../src/repo.js"
import { OUTPUT_CONTRACT, parseAnswer, resolveArtifactHtml, runAgent } from "../src/runner.js"
import { runSession } from "../src/session.js"
import { sessionApi, sessionCommand } from "../src/sessions.js"
import { materializeSkills, skillDigest, skillSlug, writeSkill } from "../src/skills.js"

describe("parseAnswer", () => {
  it("rejects a missing block, bad JSON, and an empty body", () => {
    expect(parseAnswer("no block here").error).toMatch(/no <answer>/)
    expect(parseAnswer("<answer>{nope}</answer>").error).toMatch(/parse/)
    expect(parseAnswer('<answer>{"body_md":"  "}</answer>').error).toMatch(/body_md/)
  })

  it("carries the escalation's options as short labels, and none when there are none", () => {
    const asked = parseAnswer(
      '<answer>{"body_md":"x","escalate":true,"escalation_reason":"Ban R?","escalation_options":["Ban 14 days"," Watch ",7,""]}</answer>',
    )
    expect(asked.answer.escalation_options).toEqual(["Ban 14 days", "Watch"])
    expect(parseAnswer('<answer>{"body_md":"x"}</answer>').answer.escalation_options).toEqual([])
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
})

describe("runAgent transient-failure retry (Claude Code)", () => {
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
    const out = await runAgent(claudeCode, opts(fake.bin))
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
    const out = await runAgent(claudeCode, opts(fake.bin))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/selected model/)
    expect(fake.attempts()).toBe(1) // no sleep, no second spawn
  }, 30_000)

  it("does NOT retry a spawn failure — a missing binary is not a busy service", async () => {
    const out = await runAgent(claudeCode, opts("/nonexistent/claude"))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/ENOENT/)
  }, 30_000)

  it("an error run is never salvaged — the asker must not get 'API Error: 529' as an answer", async () => {
    const fake = fakeClaude(apiError(529, "API Error: 529 Overloaded"))
    const out = await runAgent(claudeCode, opts(fake.bin))
    expect(out.ok).toBe(false)
    expect(out.error).toContain("529")
    expect(fake.attempts()).toBe(2) // bounded at one retry
  }, 30_000)

  it("takes a valid block even when the process exits nonzero after emitting it", async () => {
    const fake = fakeClaude(`
echo '{"type":"result","result":"<answer>{\\"body_md\\":\\"the work got done\\"}</answer>"}'
exit 1
`)
    const out = await runAgent(claudeCode, opts(fake.bin))
    expect(out.ok).toBe(true)
    expect(out.answer.body_md).toBe("the work got done")
  }, 30_000)

  it("does NOT retry a timeout — that's the owner's signal, not a busy service", async () => {
    // `exec`, so the SIGTERM the runner sends on timeout reaches the sleeper itself. Without
    // it the signal killed `sh` and the orphaned `sleep` kept stdout open, so the run only
    // ended when sleep did — ten seconds for a test about a half-second timeout.
    const fake = fakeClaude(`exec sleep 10`)
    const out = await runAgent(claudeCode, { ...opts(fake.bin), timeoutMs: 500 })
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
    await runAgent(claudeCode, opts(fake.bin))
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
    await runAgent(claudeCode, opts(fake.bin))
    expect(fake.args(2)).toContain("--resume")
    expect(fake.args(2)).toContain("--append-system-prompt")
  }, 30_000)

  it("retries from scratch when the run died before a session id existed", async () => {
    const fake = fakeClaude(`
if [ "$n" = 1 ]; then exit 1; fi
echo '{"type":"result","result":"<answer>{\\"body_md\\":\\"ok\\"}</answer>"}'
`)
    const out = await runAgent(claudeCode, opts(fake.bin))
    expect(out.ok).toBe(true)
    expect(fake.args(2)).not.toContain("--resume")
    expect(fake.args(2)).toContain("how many orgs?")
  }, 30_000)

  it("does NOT retry a run that produced output — that's the nudge/salvage path", async () => {
    const fake = fakeClaude(`
echo '{"type":"system","session_id":"sess-x"}'
echo '{"type":"result","result":"here is prose but no block"}'
`)
    const out = await runAgent(claudeCode, opts(fake.bin))
    expect(out.ok).toBe(true) // salvaged
    expect(out.answer.body_md).toBe("here is prose but no block")
    expect(fake.attempts()).toBe(2) // the original run + the nudge, not a retry
    expect(fake.args(2)).toContain("--resume")
  }, 30_000)
})

describe("output contract", () => {
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
})

// A mock of the three-fetcher `api` contract, backed by an in-memory catalog of
// { [id]: { [version]: { entry, files: {path: bytes} } } } for bundles and
// { [id]: { [version]: "source" } } for single-file notes.
describe("skills", () => {
  const mockApi = (bundles = {}, notes = {}) => ({
    outline: async (id, version) => {
      const v = bundles[id]?.[version]
      if (!v) throw new Error("no version")
      return {
        entry: v.entry,
        pages: Object.keys(v.files).map((path) => ({ path, type: "text/plain" })),
      }
    },
    file: async (id, path, version) => bundles[id][version].files[path],
    content: async (id, version) => {
      const s = notes[id]?.[version]
      if (s == null) throw new Error("no note")
      return s
    },
  })

  describe("skillNameFrom + skillSlug", () => {
    it("slugs to a filesystem-safe stem, null when nothing survives", () => {
      expect(skillSlug("Chart Style!")).toBe("Chart-Style")
      expect(skillSlug("a/../b")).toBe("a-..-b")
      expect(skillSlug("***")).toBeNull()
    })
  })

  describe("materializeSkills", () => {
    it("a failed skill is non-fatal: ok:false, the rest still materialize", async () => {
      const api = mockApi({
        ok1: { 1: { entry: "SKILL.md", files: { "SKILL.md": "---\nname: good\n---\n" } } },
      })
      const root = mkdtempSync(join(tmpdir(), "skills-"))
      const cat = await materializeSkills(
        api,
        [
          { id: "missing", version: 9 },
          { id: "ok1", version: 1 },
        ],
        root,
      )
      expect(cat[0]).toMatchObject({ id: "missing", ok: false })
      expect(cat[1]).toMatchObject({ id: "ok1", dir: "good", ok: true })
    })

    it("rejects a claimed Skill bundle that omits its root SKILL.md", async () => {
      const api = mockApi({
        bad: { 1: { entry: "SKILL.md", files: { "references/only.md": "not a skill" } } },
      })
      const root = mkdtempSync(join(tmpdir(), "skills-"))
      const [result] = await materializeSkills(api, [{ id: "bad", version: 1 }], root)
      expect(result).toMatchObject({ id: "bad", ok: false })
      expect(existsSync(join(root, "bad"))).toBe(false)
    })

    it("atomically replaces a skill and rejects paths outside its directory", () => {
      const root = mkdtempSync(join(tmpdir(), "skills-"))
      writeSkill(root, "safe", new Map([["SKILL.md", "old"]]))
      expect(() =>
        writeSkill(
          root,
          "safe",
          new Map([
            ["SKILL.md", "new"],
            ["../escape", "bad"],
          ]),
        ),
      ).toThrow(/unsafe skill path/)
      expect(readFileSync(join(root, "safe", "SKILL.md"), "utf8")).toBe("old")

      const next = new Map([
        ["references/readme.md", "ref"],
        ["SKILL.md", "new"],
      ])
      expect(writeSkill(root, "safe", next)).toBe(skillDigest(next))
      expect(readFileSync(join(root, "safe", "SKILL.md"), "utf8")).toBe("new")
    })
  })
})

describe("the runner command", () => {
  const bin = join(import.meta.dirname, "..", "bin", "derive.js")
  const run = (...args) =>
    spawnSync(process.execPath, [bin, ...args], {
      encoding: "utf8",
      env: { ...process.env, DERIVE_TOKEN: "" },
    })

  it("points every retired Context form at the agent runner in one line", () => {
    for (const args of [
      ["runner", "serve", "ctx_abc"],
      ["runner", "serve", "--context", "ctx_abc"],
      ["runner", "run", "dkrun_abc"],
      ["runner", "run", "dksess_abc"],
      ["runner", "doctor"],
      ["runner", "install"],
      ["context", "push"],
      ["agent", "dev"],
      ["workflow", "run"],
    ]) {
      const out = run(...args)
      expect(out.status, args.join(" ")).toBe(1)
      expect(out.stderr.trim().split("\n"), args.join(" ")).toHaveLength(1)
      expect(out.stderr).toContain("derive runner serve --agent <id>")
    }
  })

  it("--no-local-login is a switch: last on the line, or before another flag", async () => {
    // A server with one job and no stored model account: an opted-out runner must fail the
    // job plainly instead of spending this machine's own model login.
    const reports = []
    const harness = join(mkdtempSync(join(tmpdir(), "runner-version-")), "claude")
    writeFileSync(harness, "#!/bin/sh\nprintf '1.0.0\\n'\n")
    chmodSync(harness, 0o755)
    const server = createServer((req, res) => {
      let body = ""
      req.on("data", (c) => {
        body += c
      })
      req.on("end", () => {
        res.setHeader("content-type", "application/json")
        if (req.url.endsWith("/pull"))
          return res.end(
            JSON.stringify({
              jobs: [{ id: "job_1", started_at: "2026-01-01T00:00:00.000Z", messages: [] }],
            }),
          )
        if (req.url.includes("/account")) return res.end(JSON.stringify({ credential: null }))
        if (req.url.endsWith("/report")) reports.push(JSON.parse(body))
        res.end("{}")
      })
    })
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    const url = `http://127.0.0.1:${server.address().port}`
    const once = (...extra) =>
      new Promise((resolve) => {
        const p = spawn(
          process.execPath,
          [bin, "runner", "once", "--agent", "ag_1", "--token", "dk_agt_x", "--server", url]
            .concat(["--claude-bin", harness])
            .concat(extra),
          { env: { ...process.env, DERIVE_TOKEN: "", RUNNER_LOCAL_LOGIN: "" } },
        )
        p.on("exit", resolve)
      })
    try {
      for (const extra of [["--no-local-login"], ["--no-local-login", "--cwd", tmpdir()]]) {
        reports.length = 0
        await once(...extra)
        expect(reports.at(-1), extra.join(" ")).toMatchObject({ status: "failed" })
        expect(reports.at(-1).body_md, extra.join(" ")).toMatch(/no claude-code account/)
      }
    } finally {
      server.close()
    }
  })

  it("reads the agent key from --token-file, flags first, keeping it out of the process list", () => {
    const d = mkdtempSync(join(tmpdir(), "runner-token-"))
    const file = join(d, "key")
    writeFileSync(file, "dk_agt_from_file\n")
    expect(loadJobRunnerConfig({}, { agent: "ag_1", "token-file": file }).token).toBe(
      "dk_agt_from_file",
    )
    expect(
      loadJobRunnerConfig({ DERIVE_TOKEN: "dk_agt_env" }, { agent: "ag_1", "token-file": file })
        .token,
    ).toBe("dk_agt_from_file")
    expect(() => loadJobRunnerConfig({}, { agent: "ag_1", "token-file": join(d, "none") })).toThrow(
      /--token-file/,
    )
  })
})

describe("cloud sessions", () => {
  it("--here pushes this branch and hands the cloud task the repository at it", async () => {
    const root = mkdtempSync(join(tmpdir(), "derive-here-"))
    const bare = join(root, "origin.git")
    const work = join(root, "widgets")
    const git = (cwd, ...args) => execSync(`git ${args.join(" ")}`, { cwd, stdio: "pipe" })
    git(root, "init", "-q", "--bare", bare)
    git(root, "init", "-q", "-b", "main", work)
    // The checkout's origin is on GitHub; pushes land in a local bare repository instead.
    git(work, "remote", "add", "origin", "https://github.com/acme-dev/widgets.git")
    git(work, "config", `url.${bare}.pushInsteadOf`, "https://github.com/acme-dev/widgets.git")
    git(
      work,
      "-c",
      "user.email=a@b",
      "-c",
      "user.name=a",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    )
    git(work, "checkout", "-q", "-b", "fix-copy")
    const sent = []
    const api = async (path, { body } = {}) => {
      if (path === "/v1/agents")
        return { agents: [{ id: "ag_1", name: "Coding", machine: "derive", provider: "codex" }] }
      sent.push(body)
      return { id: "job_abcdef123456" }
    }
    const cwd = process.cwd()
    process.chdir(work)
    try {
      writeFileSync(join(work, "README"), "x")
      git(work, "add", "README")
      // Work not yet committed stays on the laptop, and the command says so.
      await expect(
        sessionCommand("run", ["Coding", "Fix the copy"], { here: "true" }, api, { log: () => {} }),
      ).rejects.toThrow(/commit your changes first/)
      git(work, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "wip")
      const log = console.log
      console.log = () => {}
      try {
        await sessionCommand("run", ["Coding", "Fix the copy"], { here: "true" }, api, {
          log: () => {},
        })
      } finally {
        console.log = log
      }
    } finally {
      process.chdir(cwd)
    }
    expect(sent).toEqual([
      { agent_id: "ag_1", instruction: "Fix the copy", repo: "acme-dev/widgets@fix-copy" },
    ])
    expect(git(bare, "rev-parse", "fix-copy").toString().trim()).toBe(
      git(work, "rev-parse", "HEAD").toString().trim(),
    )
  })

  it("a session parks once nobody types and its screen stops changing, even with a dropped client listed", async () => {
    let clock = 1_000_000
    let screen = "working 1s"
    const tmux = (cmd, ...args) => {
      if (cmd === "has-session") return { status: 0, stdout: "" }
      // A connection that dropped an hour ago is still listed, with its last keystroke then.
      if (cmd === "list-clients") return { status: 0, stdout: `${(clock - 3_600_000) / 1000}\n` }
      if (cmd === "capture-pane") return { status: 0, stdout: screen }
      return { status: 0, stdout: "", stderr: "", args }
    }
    const ticks = []
    const ended = runSession(
      { bin: "codex", args: [], cwd: tmpdir(), env: {} },
      {
        idleMs: 60_000,
        pollMs: 1,
        tmux,
        now: () => {
          clock += 10_000
          ticks.push(clock)
          // The harness works (the screen changes) for the first few polls, then waits.
          if (ticks.length < 6) screen = `working ${ticks.length}s`
          return clock
        },
      },
    )
    expect(await ended).toBe("idle")
    // Idle counts from the last change on screen, not from the dropped client's listing.
    expect(ticks.length).toBeGreaterThan(6)
  })

  it("a task's checkout reaches GitHub with the renewed token, through git and gh alike", () => {
    const root = mkdtempSync(join(tmpdir(), "derive-repo-"))
    const bare = join(root, "origin.git")
    execSync(`git init -q --bare ${bare}`)
    const seed = join(root, "seed")
    execSync(`git init -q -b main ${seed}`)
    execSync(`git -C ${seed} -c user.email=a@b -c user.name=a commit -q --allow-empty -m first`)
    execSync(`git -C ${seed} push -q ${bare} main`)
    // GitHub, as this test reaches it: the bare repository stands in for the remote.
    const config = join(root, "gitconfig")
    writeFileSync(
      config,
      `[url "${bare}"]\n\tinsteadOf = https://github.com/acme-dev/widgets.git\n`,
    )
    const tools = join(root, "tools")
    mkdirSync(tools)
    writeFileSync(join(tools, "gh"), '#!/bin/sh\necho "gh sees $GH_TOKEN"\n', { mode: 0o755 })
    const before = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL }
    process.env.PATH = `${tools}:${process.env.PATH}`
    process.env.GIT_CONFIG_GLOBAL = config
    try {
      const secrets = mkdtempSync(join(tmpdir(), "derive-git-"))
      const tokenFile = join(secrets, "token")
      const { dir, env } = prepareRepo(
        { repo: "acme-dev/widgets", ref: "main", token: "first-token" },
        { cwd: root, firstTurn: true, tokenFile },
      )
      expect(existsSync(join(dir, ".git"))).toBe(true)
      const gh = () =>
        execSync("gh auth status", { env: { ...process.env, ...env }, encoding: "utf8" }).trim()
      expect(gh()).toBe("gh sees first-token")
      // The runner renews the token in place; the harness's gh picks it up without a restart.
      writeFileSync(tokenFile, "renewed-token")
      expect(gh()).toBe("gh sees renewed-token")
    } finally {
      process.env.PATH = before.PATH
      if (before.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = before.GIT_CONFIG_GLOBAL
    }
  })

  it("on a shared box, each task works in its own worktree and keeps it for follow-ups", () => {
    const root = mkdtempSync(join(tmpdir(), "derive-box-"))
    const bare = join(root, "origin.git")
    execSync(`git init -q --bare ${bare}`)
    const seed = join(root, "seed")
    execSync(`git init -q -b main ${seed}`)
    execSync(`git -C ${seed} -c user.email=a@b -c user.name=a commit -q --allow-empty -m first`)
    execSync(`git -C ${seed} push -q ${bare} main`)
    const config = join(root, "gitconfig")
    writeFileSync(
      config,
      `[url "${bare}"]\n\tinsteadOf = https://github.com/acme-dev/widgets.git\n`,
    )
    const before = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = config
    try {
      const work = join(root, "work")
      mkdirSync(work)
      const checkout = (task) =>
        prepareRepo(
          { repo: "acme-dev/widgets", ref: "main", token: "t" },
          {
            cwd: work,
            firstTurn: true,
            tokenFile: join(mkdtempSync(join(tmpdir(), "g-")), "t"),
            task,
          },
        ).dir
      const a = checkout("job_a")
      const b = checkout("job_b")
      // Two tasks at once, two folders: one task's edits never reach the other.
      expect(a).not.toBe(b)
      writeFileSync(join(a, "change.txt"), "task a")
      expect(existsSync(join(b, "change.txt"))).toBe(false)
      // A follow-up on task a returns to its own folder with the work in progress.
      expect(checkout("job_a")).toBe(a)
      expect(readFileSync(join(a, "change.txt"), "utf8")).toBe("task a")
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = before
    }
  })
})

describe("cloud session SSH transport", () => {
  const bin = join(import.meta.dirname, "..", "bin", "derive.js")
  const payload = Buffer.from(Array.from({ length: 153_600 }, (_, i) => i % 256))
  const claim = "2026-01-01T00:00:00.000Z"
  const fixture = async ({
    access = {},
    peer = "echo",
    direct = false,
    hold = false,
    specialPaths = false,
    specialIdentity = false,
  } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "derive-ssh-test-"))
    const sessionTmp = specialPaths
      ? join(dir, 'private spaces "quote" \\slash %tokens ${UNSET_SSH_VARIABLE}')
      : dir
    mkdirSync(sessionTmp, { recursive: true })
    const configDir = specialIdentity
      ? join(dir, 'identity spaces "quote" \\slash %tokens ${UNSET_SSH_VARIABLE}')
      : dir
    mkdirSync(configDir, { recursive: true })
    const key = join(configDir, "session_ed25519")
    for (const file of [key, join(dir, "ca")]) {
      const made = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file])
      expect(made.status).toBe(0)
    }
    const signed = spawnSync("ssh-keygen", [
      "-q",
      "-s",
      join(dir, "ca"),
      "-I",
      "test",
      "-n",
      "ortam",
      "-V",
      "-1m:+5m",
      `${key}.pub`,
    ])
    expect(signed.status).toBe(0)
    const hostKey = readFileSync(join(dir, "ca.pub"), "utf8").trim()
    const certificate = readFileSync(`${key}-cert.pub`, "utf8").trim()
    const knownHosts = join(dir, "known_hosts")
    writeFileSync(knownHosts, "existing-host sentinel\n")
    const record = join(dir, "ssh-record.json")
    const executable = join(dir, "ssh")
    writeFileSync(
      executable,
      `#!${process.execPath}
import { writeFileSync, readFileSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
const args = process.argv.slice(2)
const option = prefix => args.find(a => a.startsWith(prefix))?.slice(prefix.length)
const configuration = spawnSync('/usr/bin/ssh', ['-G', ...args], {encoding:'utf8'})
if (configuration.status !== 0) { process.stderr.write(configuration.stderr); process.exit(configuration.status ?? 1) }
const knownOption = option('UserKnownHostsFile=')
const certificateOption = option('CertificateFile=')
const known = knownOption && resolve(knownOption)
const certificate = certificateOption && resolve(certificateOption)
const identity = resolve(args[args.indexOf('-i') + 1])
const identityKey = spawnSync('ssh-keygen', ['-y', '-f', identity], {encoding:'utf8'})
if (identityKey.status !== 0) { process.stderr.write(identityKey.stderr); process.exit(identityKey.status ?? 1) }
writeFileSync(process.env.SSH_RECORD, JSON.stringify({ args, known, certificate, identity, identityPublicKey: identityKey.stdout.trim(), identityMode: statSync(identity).mode & 511, hostKey: known && readFileSync(known, 'utf8'), cert: certificate && readFileSync(certificate, 'utf8'), mode: known && (statSync(known).mode & 511), certMode: certificate && (statSync(certificate).mode & 511), dirMode: known && (statSync(known.slice(0, known.lastIndexOf('/'))).mode & 511) }))
if (process.env.SSH_DIRECT === '1') process.exit(0)
const expected = Buffer.from(Array.from({length:153600}, (_,i)=>i%256))
const socket = connect(Number(args[args.indexOf('-p')+1]), '127.0.0.1', () => socket.write(expected))
let chunks = [], bytes = 0
socket.on('data', data => {
  chunks.push(data); bytes += data.length
  if (bytes === expected.length) {
    if (!Buffer.concat(chunks).equals(expected)) process.exit(9)
    if (process.env.SSH_HOLD === '1') process.stdout.write('SSH_READY\\n')
    else { socket.end(); process.exit(0) }
  }
})
socket.on('error', () => process.exit(8))
socket.on('end', () => process.exit(7))
`,
    )
    chmodSync(executable, 0o755)
    const upgradeRequests = []
    const frames = []
    const publicKeys = []
    const sockets = new Set()
    const wss = new WebSocketServer({ noServer: true })
    wss.on("connection", (ws) => {
      sockets.add(ws)
      ws.on("close", () => sockets.delete(ws))
      ws.on("message", (data, binary) => {
        frames.push({ data: Buffer.from(data), binary })
        if (peer === "text") ws.send("invalid text")
        else if (peer === "oversize") ws.send(Buffer.alloc(1_048_577))
        else ws.send(data, { binary: true })
      })
    })
    const server = createServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => {
        body += chunk
      })
      req.on("end", () => {
        res.setHeader("content-type", "application/json")
        const task = {
          id: "job_session",
          agent_id: "ag_1",
          machine_phase: "running",
          status: "running",
        }
        if (req.url === "/v1/agents")
          return res.end(JSON.stringify({ agents: [{ id: "ag_1", machine: "derive" }] }))
        if (req.url.startsWith("/v1/jobs?")) return res.end(JSON.stringify({ jobs: [task] }))
        if (req.url === "/v1/jobs/job_session/attach") {
          publicKeys.push(JSON.parse(body).public_key)
          return res.end(
            JSON.stringify({
              ...(direct
                ? { host: "127.0.0.1", port: 2222, user: "root" }
                : {
                    transport: "websocket",
                    user: "ortam",
                    certificate,
                    certificate_expires_at: new Date(Date.now() + 300_000).toISOString(),
                    tunnel_path: "/v1/jobs/job_session/ssh",
                    claim,
                  }),
              host_key: hostKey,
              tmux_session: "derive",
              ...access,
            }),
          )
        }
        res.end(JSON.stringify(task))
      })
    })
    server.on("upgrade", (req, socket, head) => {
      upgradeRequests.push({ url: req.url, headers: req.headers })
      if (peer === "refuse") {
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const url = `http://127.0.0.1:${server.address().port}`
    writeFileSync(
      join(configDir, "credentials.json"),
      JSON.stringify({
        [url]: {
          defaultAccount: "test",
          accounts: {
            test: { defaultWorkspace: "org_cli", workspaces: { org_cli: { name: "CLI" } } },
          },
        },
      }),
    )
    const run = (command = "attach") => {
      const child = spawn(
        process.execPath,
        [
          bin,
          command,
          "job_session",
          ...(command === "forward" ? ["3000:3333"] : []),
          "--server",
          url,
          "--token",
          "test-session-token",
        ],
        {
          cwd: dir,
          env: {
            ...process.env,
            DERIVE_CONFIG_DIR: configDir,
            DERIVE_SERVER: url,
            PATH: `${dir}:${process.env.PATH}`,
            SSH_RECORD: record,
            TMPDIR: sessionTmp,
            SSH_DIRECT: direct ? "1" : "",
            SSH_HOLD: hold ? "1" : "",
          },
        },
      )
      let stdout = "",
        stderr = ""
      child.stdout.on("data", (data) => {
        stdout += data
      })
      child.stderr.on("data", (data) => {
        stderr += data
      })
      const done = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL")
          reject(new Error(`CLI timed out: ${stderr}`))
        }, 10_000)
        child.on("error", reject)
        child.on("exit", (code) => {
          clearTimeout(timeout)
          resolve({ code, stdout, stderr })
        })
      })
      return { child, done }
    }
    return {
      dir,
      record,
      key,
      certificate,
      hostKey,
      frames,
      upgradeRequests,
      publicKeys,
      sockets,
      run,
      async close() {
        for (const socket of sockets) socket.terminate()
        wss.close()
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
        rmSync(dir, { recursive: true, force: true })
      },
    }
  }

  it("attaches and forwards through a binary authenticated tunnel, preserving bytes and cleaning private files", async () => {
    const f = await fixture()
    try {
      const paths = []
      for (const command of ["attach", "forward"]) {
        const result = await f.run(command).done
        expect(result.code, result.stderr).toBe(0)
        const record = JSON.parse(readFileSync(f.record, "utf8"))
        paths.push(record.known)
        expect(record.mode).toBe(0o600)
        expect(record.certMode).toBe(0o600)
        expect(record.dirMode).toBe(0o700)
        expect(record.hostKey).toBe(`derive-session ${f.hostKey}\n`)
        expect(record.cert.trim()).toBe(f.certificate)
        expect(record.args).toContain("StrictHostKeyChecking=yes")
        expect(record.args).toContain("IdentitiesOnly=yes")
        expect(record.identityPublicKey.split(/\s+/).slice(0, 2)).toEqual(
          f.publicKeys[0].split(/\s+/).slice(0, 2),
        )
        expect(record.identityMode).toBe(0o600)
        expect(existsSync(record.identity)).toBe(false)
        expect(existsSync(f.key)).toBe(true)
        expect(record.args).not.toContain("test-session-token")
        expect(existsSync(record.known)).toBe(false)
        expect(existsSync(record.certificate)).toBe(false)
        if (command === "attach") expect(record.args.at(-1)).toContain("tmux attach -t derive")
        else expect(record.args).toContain("3333:127.0.0.1:3000")
        expect(f.frames.every((frame) => frame.binary && frame.data.length <= 32_768)).toBe(true)
        expect(Buffer.concat(f.frames.map((frame) => frame.data))).toEqual(payload)
        f.frames.length = 0
      }
      expect(paths[0]).not.toBe(paths[1])
      expect(readFileSync(join(f.dir, "known_hosts"), "utf8")).toBe("existing-host sentinel\n")
      expect(f.publicKeys).toEqual([
        readFileSync(`${f.key}.pub`, "utf8").trim(),
        readFileSync(`${f.key}.pub`, "utf8").trim(),
      ])
      expect(f.upgradeRequests).toHaveLength(2)
      for (const request of f.upgradeRequests) {
        expect(request.url).toBe("/v1/jobs/job_session/ssh")
        expect(request.headers.authorization).toBe("Bearer test-session-token")
        expect(request.headers["x-derive-workspace"]).toBe("org_cli")
        expect(request.headers["x-derive-job-claim"]).toBe(claim)
      }
    } finally {
      await f.close()
    }
  })

  it("uses literal private paths containing spaces, quotes, backslashes and SSH expansion tokens", async () => {
    const f = await fixture({ specialPaths: true })
    try {
      const result = await f.run().done
      expect(result.code, result.stderr).toBe(0)
      const record = JSON.parse(readFileSync(f.record, "utf8"))
      expect(record.cert.trim()).toBe(f.certificate)
      expect(record.hostKey).toBe(`derive-session ${f.hostKey}\n`)
      expect(record.known).toContain('private spaces "quote" \\slash %tokens ${UNSET_SSH_VARIABLE}')
      expect(existsSync(record.known)).toBe(false)
      expect(existsSync(record.certificate)).toBe(false)
      expect(Buffer.concat(f.frames.map((frame) => frame.data))).toEqual(payload)
    } finally {
      await f.close()
    }
  })

  it("uses the correct private key from a literal config path and removes only its temporary copy", async () => {
    const f = await fixture({ specialIdentity: true })
    try {
      const result = await f.run().done
      expect(result.code, result.stderr).toBe(0)
      const record = JSON.parse(readFileSync(f.record, "utf8"))
      expect(record.identityPublicKey.split(/\s+/).slice(0, 2)).toEqual(
        f.publicKeys[0].split(/\s+/).slice(0, 2),
      )
      expect(record.identityMode).toBe(0o600)
      expect(existsSync(record.identity)).toBe(false)
      expect(existsSync(f.key)).toBe(true)
      expect(Buffer.concat(f.frames.map((frame) => frame.data))).toEqual(payload)
    } finally {
      await f.close()
    }
  })

  it.each([
    "text",
    "oversize",
    "refuse",
  ])("fails closed for %s from the tunnel and removes its files", async (peer) => {
    const f = await fixture({ peer })
    try {
      const result = await f.run().done
      expect(result.code, result.stderr).toBe(1)
      expect(result.stderr).toMatch(/SSH tunnel/)
      const record = JSON.parse(readFileSync(f.record, "utf8"))
      expect(existsSync(record.known)).toBe(false)
      expect(existsSync(record.certificate)).toBe(false)
    } finally {
      await f.close()
    }
  })

  it.each([
    { certificate_expires_at: "2020-01-01T00:00:00.000Z" },
    { certificate: "ssh-ed25519 ordinary-key" },
    { tunnel_path: "https://other.example/v1/jobs/job_session/ssh" },
    { tunnel_path: "/v1/jobs/other/ssh" },
    { host_key: "ssh-ed25519 key\ninjected" },
    { tmux_session: "derive; malicious" },
  ])("rejects invalid attachment details before invoking SSH (%j)", async (access) => {
    const f = await fixture({ access })
    try {
      const result = await f.run().done
      expect(result.code).toBe(1)
      expect(existsSync(f.record)).toBe(false)
      expect(f.upgradeRequests).toHaveLength(0)
    } finally {
      await f.close()
    }
  })

  it("keeps the direct Boat response working with a separate pinned-host file", async () => {
    const f = await fixture({ direct: true })
    try {
      const result = await f.run().done
      expect(result.code, result.stderr).toBe(0)
      const record = JSON.parse(readFileSync(f.record, "utf8"))
      expect(record.args).toContain("root@127.0.0.1")
      expect(record.args[record.args.indexOf("-p") + 1]).toBe("2222")
      expect(record.certificate).toBeUndefined()
      expect(existsSync(record.known)).toBe(false)
      expect(f.upgradeRequests).toHaveLength(0)
    } finally {
      await f.close()
    }
  })

  it("keeps OpenSSH's persistent host trust when Boat returns no host key", async () => {
    const f = await fixture({ direct: true, access: { host_key: null } })
    try {
      const result = await f.run().done
      expect(result.code, result.stderr).toBe(0)
      const record = JSON.parse(readFileSync(f.record, "utf8"))
      expect(record.args).toContain("StrictHostKeyChecking=accept-new")
      expect(record.args).not.toContain("-F")
      expect(
        record.args.some((arg) =>
          /^(?:UserKnownHostsFile|GlobalKnownHostsFile|HostKeyAlias)=/.test(arg),
        ),
      ).toBe(false)
      expect(readFileSync(join(f.dir, "known_hosts"), "utf8")).toBe("existing-host sentinel\n")
      expect(f.upgradeRequests).toHaveLength(0)
    } finally {
      await f.close()
    }
  })

  it("interrupts a forwarded session and tears down its relay", async () => {
    const f = await fixture({ hold: true })
    const run = f.run("forward")
    try {
      await new Promise((resolve, reject) => {
        run.child.stdout.on("data", (data) => {
          if (data.toString().includes("SSH_READY")) resolve()
        })
        run.done.then(() => reject(new Error("SSH ended before the interruption")), reject)
      })
      run.child.kill("SIGINT")
      const result = await run.done
      expect(result.code).toBe(130)
      const record = JSON.parse(readFileSync(f.record, "utf8"))
      expect(existsSync(record.known)).toBe(false)
      expect(existsSync(record.certificate)).toBe(false)
    } finally {
      run.child.kill("SIGKILL")
      await f.close()
    }
  })

  it("refuses arbitrary URLs and non-task paths in the authenticated tunnel capability", () => {
    const api = sessionApi({
      server: "https://derive.example",
      token: "test-session-token",
      workspaceId: "org_cli",
    })
    for (const path of [
      "https://other.example/ssh",
      "//other.example/ssh",
      "/v1/jobs/job_session/ssh?token=x",
      "/v1/jobs/../ssh",
      "/v1/artifacts/x/ssh",
    ])
      expect(() => api.openSshTunnel(path, claim)).toThrow(/invalid SSH tunnel/)
  })
})

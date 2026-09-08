import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  addToArtifactScanSpool,
  commitArtifactScanState,
  scanArtifactLogs,
} from "../src/artifact-scan.js"
import { setupDeriveScan } from "../src/derive-scan-setup.js"
import { acquireScanLock } from "../src/scan-state.js"
import { addToSkillScanSpool, recordSkillInstall, scanSkillLogs } from "../src/skill-scan.js"
import { setupSkillScan } from "../src/skill-scan-setup.js"

const dirs = []
const servers = []

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const run = (cwd, server, args, extraEnv = {}) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, "..", "bin", "derive.js"), ...args, "--server", server],
      {
        cwd,
        env: {
          ...process.env,
          DERIVE_TOKEN: "test-token",
          DERIVE_CONFIG_DIR: join(cwd, ".derive-test-config"),
          ...extraEnv,
        },
      },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("close", (status) => resolve({ status, stdout, stderr }))
  })

describe("derive skill sync --all", () => {
  it("reports an empty project before requiring authentication", async () => {
    const project = mkdtempSync(join(tmpdir(), "derive-sync-all-empty-"))
    dirs.push(project)
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, "..", "bin", "derive.js"), "skill", "sync", "--all"],
      {
        cwd: project,
        env: {
          PATH: process.env.PATH,
        },
      },
    )
    let stderr = ""
    child.stderr.on("data", (chunk) => (stderr += chunk))
    const status = await new Promise((resolve) => child.on("close", resolve))

    expect(status).toBe(1)
    expect(stderr).toContain("no installed skills match")
    expect(stderr).not.toContain("not signed in")
  })

  it("updates every pin while preserving its installed clients", async () => {
    const receipts = []
    const names = { alpha: "Alpha Skill", beta: "Beta Skill" }
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1")
      const send = (status, value, type = "application/json") => {
        response.writeHead(status, { "content-type": type })
        response.end(type === "application/json" ? JSON.stringify(value) : value)
      }
      const detail = url.pathname.match(/^\/v1\/artifacts\/([^/]+)$/)
      if (detail) return send(200, { current_version: 2, bundle: { isSkill: true } })
      const content = url.pathname.match(/^\/v1\/artifacts\/([^/]+)\/content$/)
      if (content) {
        const name = names[content[1]]
        if (url.searchParams.has("outline"))
          return send(200, {
            entry: "SKILL.md",
            pages: [{ path: "SKILL.md", type: "text/markdown" }],
          })
        return send(
          200,
          `---\nname: ${name}\ndescription: fixture\n---\n\nVersion two.\n`,
          "application/octet-stream",
        )
      }
      const receipt = url.pathname.match(/^\/v1\/artifacts\/([^/]+)\/skill-installation$/)
      if (receipt && request.method === "PUT") {
        let body = ""
        request.on("data", (chunk) => (body += chunk))
        request.on("end", () => {
          receipts.push({ id: receipt[1], ...JSON.parse(body) })
          send(200, { ok: true })
        })
        return
      }
      send(404, { error: "not found" })
    })
    servers.push(server)
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const project = mkdtempSync(join(tmpdir(), "derive-sync-all-"))
    dirs.push(project)
    writeFileSync(
      join(project, "derive.json"),
      JSON.stringify({
        title: "Fixture",
        entry: "index.md",
        skills: [
          {
            id: "alpha",
            version: 1,
            name: names.alpha,
            installs: { claude: { version: 1 }, codex: { version: 1 } },
          },
          {
            id: "beta",
            version: 1,
            name: names.beta,
            installs: { claude: { version: 1 } },
          },
        ],
      }),
    )

    const result = await run(project, base, ["skill", "sync", "--all"])

    expect(result).toMatchObject({ status: 0 })
    expect(result.stdout).toContain("synced 2 installed skills")
    expect(existsSync(join(project, ".claude/skills/Alpha-Skill/SKILL.md"))).toBe(true)
    expect(existsSync(join(project, ".agents/skills/Alpha-Skill/SKILL.md"))).toBe(true)
    expect(existsSync(join(project, ".claude/skills/Beta-Skill/SKILL.md"))).toBe(true)
    expect(existsSync(join(project, ".agents/skills/Beta-Skill"))).toBe(false)
    expect(receipts.map(({ id, client }) => `${id}:${client}`).sort()).toEqual([
      "alpha:claude",
      "alpha:codex",
      "beta:claude",
    ])
    const config = JSON.parse(readFileSync(join(project, "derive.json"), "utf8"))
    expect(config.skills.find((skill) => skill.id === "alpha").installs).toEqual({
      claude: { version: 2, name: names.alpha },
      codex: { version: 2, name: names.alpha },
    })
    expect(config.skills.find((skill) => skill.id === "beta").installs).toEqual({
      claude: { version: 2, name: names.beta },
    })
  })
})

describe("derive skill used", () => {
  it("reports the pinned version and can rate the same event", async () => {
    const receipts = []
    const server = http.createServer((request, response) => {
      const send = (status, value) => {
        response.writeHead(status, { "content-type": "application/json" })
        response.end(JSON.stringify(value))
      }
      if (request.url === "/v1/artifacts/review-skill/skill-usage" && request.method === "POST") {
        let body = ""
        request.on("data", (chunk) => (body += chunk))
        request.on("end", () => {
          receipts.push(JSON.parse(body))
          send(200, { ok: true })
        })
        return
      }
      send(404, { error: "not found" })
    })
    servers.push(server)
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const project = mkdtempSync(join(tmpdir(), "derive-skill-used-"))
    dirs.push(project)
    writeFileSync(
      join(project, "derive.json"),
      JSON.stringify({
        skills: [
          {
            id: "review-skill",
            version: 4,
            name: "Review",
            installs: { codex: { version: 4, name: "Review" } },
          },
        ],
      }),
    )

    const first = await run(project, base, [
      "skill",
      "used",
      "review-skill",
      "--client",
      "codex",
      "--event",
      "dogfood-event-1",
    ])
    const rated = await run(project, base, [
      "skill",
      "used",
      "review-skill",
      "--client",
      "codex",
      "--event",
      "dogfood-event-1",
      "--useful",
      "yes",
    ])

    expect(first).toMatchObject({ status: 0 })
    expect(first.stdout).toContain("Review @v4 used by codex")
    expect(receipts).toHaveLength(2)
    expect(receipts[0]).not.toHaveProperty("useful")
    expect(receipts[1]).toMatchObject({
      event_id: "dogfood-event-1",
      skill_version: 4,
      client: "codex",
      useful: true,
    })
    expect(rated.status).toBe(0)
  })
})

describe("derive skill scan", () => {
  it("finds structured Claude attribution and Codex Skill file reads incrementally", async () => {
    const root = mkdtempSync(join(tmpdir(), "derive-skill-scan-"))
    dirs.push(root)
    const home = join(root, "home")
    const config = join(root, "config")
    const priorConfig = process.env.DERIVE_CONFIG_DIR
    process.env.DERIVE_CONFIG_DIR = config
    try {
      const codexSkill = join(home, ".codex", "skills", "review-skill")
      const claudeSkill = join(home, ".claude", "skills", "review-skill")
      recordSkillInstall({
        id: "review123",
        version: 4,
        name: "review-skill",
        client: "codex",
        path: codexSkill,
        digest: "a".repeat(64),
        scope: "personal",
        server: "https://derive.test",
        workspaceId: "workspace-test",
        accountId: "account-test",
      })
      recordSkillInstall({
        id: "review123",
        version: 4,
        name: "review-skill",
        client: "claude",
        path: claudeSkill,
        digest: "a".repeat(64),
        scope: "personal",
        server: "https://derive.test",
        workspaceId: "workspace-test",
        accountId: "account-test",
      })

      const codexLog = join(home, ".codex", "sessions", "rollout-session-a.jsonl")
      mkdirSync(join(home, ".codex", "sessions"), { recursive: true })
      writeFileSync(
        codexLog,
        `${[
          {
            type: "session_meta",
            timestamp: "2026-09-05T12:00:00.000Z",
            payload: { id: "session-a" },
          },
          {
            type: "turn_context",
            timestamp: "2026-09-05T12:01:00.000Z",
            payload: { turn_id: "turn-a" },
          },
          {
            type: "response_item",
            timestamp: "2026-09-05T12:01:01.000Z",
            payload: {
              type: "function_call",
              name: "exec_command",
              call_id: "call-a",
              arguments: JSON.stringify({ cmd: `cat ${codexSkill}/SKILL.md` }),
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n")}\n`,
      )
      const claudeLog = join(home, ".claude", "projects", "project-a", "session-b.jsonl")
      mkdirSync(join(home, ".claude", "projects", "project-a"), { recursive: true })
      writeFileSync(
        claudeLog,
        `${[
          {
            type: "user",
            timestamp: "2026-09-05T12:02:00.000Z",
            sessionId: "session-b",
            promptId: "prompt-b",
          },
          {
            type: "assistant",
            timestamp: "2026-09-05T12:02:01.000Z",
            sessionId: "session-b",
            attributionSkill: "review-skill",
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n")}\n`,
      )

      const first = await scanSkillLogs({ home, since: "30d", now: Date.parse("2026-09-06") })
      expect(first.events).toHaveLength(2)
      expect(first.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            client: "codex",
            evidence: "skill_file_read",
            stage: "loaded",
          }),
          expect.objectContaining({
            client: "claude",
            evidence: "structured_log",
            stage: "loaded",
          }),
        ]),
      )
      expect(first.events.every((event) => !JSON.stringify(event).includes(home))).toBe(true)

      const second = await scanSkillLogs({ home, now: Date.parse("2026-09-06") })
      expect(second.events).toEqual([])
    } finally {
      if (priorConfig === undefined) delete process.env.DERIVE_CONFIG_DIR
      else process.env.DERIVE_CONFIG_DIR = priorConfig
    }
  })

  it("keeps Codex session context across an incremental append", async () => {
    const root = mkdtempSync(join(tmpdir(), "derive-skill-scan-context-"))
    dirs.push(root)
    const home = join(root, "home")
    const config = join(root, "config")
    const priorConfig = process.env.DERIVE_CONFIG_DIR
    process.env.DERIVE_CONFIG_DIR = config
    try {
      const skillPath = join(home, ".codex", "skills", "review-skill")
      recordSkillInstall({
        id: "review123",
        version: 4,
        name: "review-skill",
        client: "codex",
        path: skillPath,
        digest: "a".repeat(64),
        scope: "personal",
        server: "https://derive.test",
        workspaceId: "workspace-test",
        accountId: "account-test",
      })
      const log = join(home, ".codex", "sessions", "rollout.jsonl")
      mkdirSync(join(home, ".codex", "sessions"), { recursive: true })
      writeFileSync(
        log,
        `${JSON.stringify({
          type: "session_meta",
          timestamp: "2026-09-05T12:00:00.000Z",
          payload: { id: "session-a" },
        })}\n${JSON.stringify({
          type: "turn_context",
          timestamp: "2026-09-05T12:01:00.000Z",
          payload: { turn_id: "turn-a" },
        })}\n`,
      )
      expect((await scanSkillLogs({ home })).events).toEqual([])
      // A scheduled no-op between the header and append must preserve context too.
      expect((await scanSkillLogs({ home })).events).toEqual([])
      writeFileSync(
        log,
        `${JSON.stringify({
          type: "response_item",
          timestamp: "2026-09-05T12:01:01.000Z",
          payload: {
            type: "function_call",
            call_id: "call-a",
            arguments: JSON.stringify({ cmd: `cat ${skillPath}/SKILL.md` }),
          },
        })}\n`,
        { flag: "a" },
      )
      const result = await scanSkillLogs({ home })
      expect(result.events).toHaveLength(1)
      expect(result.events[0].opaque_session_id).toBe(
        createHash("sha256")
          .update(["derive-skill-session-v1", "codex", "session-a"].join("\0"))
          .digest("hex"),
      )
    } finally {
      if (priorConfig === undefined) delete process.env.DERIVE_CONFIG_DIR
      else process.env.DERIVE_CONFIG_DIR = priorConfig
    }
  })

  it("installs idempotent session-end hooks and a macOS schedule", () => {
    const root = mkdtempSync(join(tmpdir(), "derive-skill-scan-setup-"))
    dirs.push(root)
    const codexHooks = join(root, ".codex", "hooks.json")
    mkdirSync(join(root, ".codex"), { recursive: true })
    writeFileSync(codexHooks, JSON.stringify({ description: "keep me" }))

    const first = setupSkillScan({
      home: root,
      node: "/usr/bin/node",
      cli: "/usr/local/bin/derive",
      platform: "darwin",
      schedule: true,
      activate: false,
    })
    const second = setupSkillScan({
      home: root,
      node: "/usr/bin/node",
      cli: "/usr/local/bin/derive",
      platform: "darwin",
      schedule: true,
      activate: false,
    })

    expect(first.hooks.every((hook) => hook.changed)).toBe(true)
    expect(second.hooks.every((hook) => !hook.changed)).toBe(true)
    expect(JSON.parse(readFileSync(codexHooks, "utf8"))).toMatchObject({ description: "keep me" })
    expect(readFileSync(first.schedule, "utf8")).toContain("to.derive.skill-scan")
  })

  it("limits setup hooks and schedules to the selected client", () => {
    const root = mkdtempSync(join(tmpdir(), "derive-skill-scan-client-"))
    dirs.push(root)
    const setup = setupSkillScan({
      home: root,
      node: "/usr/bin/node",
      cli: "/usr/local/bin/derive",
      platform: "darwin",
      client: "codex",
      schedule: true,
      activate: false,
    })

    expect(setup.hooks).toHaveLength(1)
    expect(setup.hooks[0].client).toBe("codex")
    expect(existsSync(join(root, ".claude", "settings.json"))).toBe(false)
    expect(readFileSync(join(root, ".codex", "hooks.json"), "utf8")).toContain("--client codex")
    expect(readFileSync(setup.schedule, "utf8")).toContain(
      "<string>--client</string><string>codex</string>",
    )
  })

  it("does not install hooks when scheduling is unsupported", () => {
    const root = mkdtempSync(join(tmpdir(), "derive-skill-scan-unsupported-"))
    dirs.push(root)

    expect(() =>
      setupSkillScan({ home: root, platform: "freebsd", schedule: true, activate: false }),
    ).toThrow("automatic schedule is not supported on freebsd")
    expect(existsSync(join(root, ".codex", "hooks.json"))).toBe(false)
    expect(existsSync(join(root, ".claude", "settings.json"))).toBe(false)
  })

  it("uploads scanned receipts in API-sized batches", async () => {
    const received = []
    const server = http.createServer((request, response) => {
      if (request.url === "/v1/skill-usage/batch" && request.method === "POST") {
        let body = ""
        request.on("data", (chunk) => (body += chunk))
        request.on("end", () => {
          received.push(JSON.parse(body))
          response.writeHead(200, { "content-type": "application/json" })
          response.end(JSON.stringify({ recorded: 1, coverage: 1 }))
        })
        return
      }
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "not found" }))
    })
    servers.push(server)
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const project = mkdtempSync(join(tmpdir(), "derive-skill-scan-cli-"))
    dirs.push(project)
    const home = join(project, "home")
    const config = join(project, ".derive-test-config")
    const skillPath = join(home, ".claude", "skills", "review-skill")
    mkdirSync(config, { recursive: true })
    writeFileSync(
      join(config, "skill-installs.json"),
      JSON.stringify({
        version: 1,
        installs: [
          {
            id: "review123",
            version: 4,
            name: "review-skill",
            client: "claude",
            path: skillPath,
            digest: "a".repeat(64),
            scope: "personal",
            server: base,
            workspace_id: null,
            account_id: null,
            updated_at: "2026-09-05T12:00:00.000Z",
          },
        ],
      }),
    )
    const log = join(home, ".claude", "projects", "project-a", "session-a.jsonl")
    mkdirSync(join(home, ".claude", "projects", "project-a"), { recursive: true })
    const records = Array.from({ length: 501 }, (_, index) => [
      {
        type: "user",
        timestamp: new Date().toISOString(),
        sessionId: "session-a",
        promptId: `prompt-${index}`,
      },
      {
        type: "assistant",
        timestamp: new Date().toISOString(),
        sessionId: "session-a",
        attributionSkill: "review-skill",
      },
    ]).flat()
    writeFileSync(log, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

    const result = await run(project, base, ["skill", "scan", "--since", "30d", "--json"], {
      HOME: home,
    })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ found: 501, uploaded: 501, pending: 0 })
    expect(received).toHaveLength(26)
    expect(received.slice(0, -1).every((batch) => batch.uses.length === 20)).toBe(true)
    expect(received.at(-1).uses).toHaveLength(1)
    expect(received[0].coverage).toEqual([])
    expect(received[0].uses[0]).toMatchObject({
      skill_short_id: "review123",
      client: "claude",
      evidence: "structured_log",
    })
    expect(received.at(-1).coverage).toEqual([
      expect.objectContaining({ client: "claude", sessions_scanned: 1 }),
    ])
  })

  it("keeps a nonzero status for a quiet failed upload", async () => {
    const project = mkdtempSync(join(tmpdir(), "derive-skill-scan-quiet-failure-"))
    dirs.push(project)
    const home = join(project, "home")
    const config = join(project, ".derive-test-config")
    const skillPath = join(home, ".claude", "skills", "review-skill")
    mkdirSync(config, { recursive: true })
    writeFileSync(
      join(config, "skill-installs.json"),
      JSON.stringify({
        version: 1,
        installs: [
          {
            id: "review123",
            version: 4,
            name: "review-skill",
            client: "claude",
            path: skillPath,
            scope: "personal",
            server: "https://derive.test",
            workspace_id: null,
            account_id: null,
          },
        ],
      }),
    )
    const log = join(home, ".claude", "projects", "project-a", "session-a.jsonl")
    mkdirSync(join(home, ".claude", "projects", "project-a"), { recursive: true })
    writeFileSync(
      log,
      `${JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        sessionId: "session-a",
        attributionSkill: "review-skill",
      })}\n`,
    )

    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, "..", "bin", "derive.js"), "skill", "scan", "--quiet"],
      {
        cwd: project,
        env: { PATH: process.env.PATH, HOME: home, DERIVE_CONFIG_DIR: config },
      },
    )
    const status = await new Promise((resolve) => child.on("close", resolve))
    expect(status).toBe(1)
    expect(
      JSON.parse(readFileSync(join(config, "skill-scan-spool.json"), "utf8")).pending,
    ).toHaveLength(1)
  })

  it("does not overwrite a malformed receipt spool", () => {
    const root = mkdtempSync(join(tmpdir(), "derive-skill-scan-spool-"))
    dirs.push(root)
    const priorConfig = process.env.DERIVE_CONFIG_DIR
    process.env.DERIVE_CONFIG_DIR = root
    try {
      writeFileSync(join(root, "skill-scan-spool.json"), "{broken")
      expect(() => addToSkillScanSpool([], [])).toThrow("cannot read Skill scan spool")
      expect(readFileSync(join(root, "skill-scan-spool.json"), "utf8")).toBe("{broken")
    } finally {
      if (priorConfig === undefined) delete process.env.DERIVE_CONFIG_DIR
      else process.env.DERIVE_CONFIG_DIR = priorConfig
    }
  })
})

describe("derive scan", () => {
  const scanFixture = async (work) => {
    const root = mkdtempSync(join(tmpdir(), "derive-scan-regression-"))
    dirs.push(root)
    const previous = process.env.DERIVE_CONFIG_DIR
    process.env.DERIVE_CONFIG_DIR = root
    const log = join(root, "session.jsonl")
    const sources = [{ client: "codex", path: log }]
    const now = Date.parse("2026-09-08")
    const records = (name = "mcp__derive__read", output = { short_id: "scan1234", version: 2 }) => [
      { type: "session_meta", payload: { id: "scan-session" } },
      {
        type: "response_item",
        timestamp: "2026-09-07T12:00:00.000Z",
        payload: { type: "function_call", name, call_id: "scan-call", arguments: "{}" },
      },
      {
        type: "response_item",
        timestamp: "2026-09-07T12:00:01.000Z",
        payload: {
          type: "function_call_output",
          call_id: "scan-call",
          output: JSON.stringify(output),
        },
      },
    ]
    const write = (rows, append = false) =>
      writeFileSync(log, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, {
        flag: append ? "a" : "w",
      })
    try {
      await work({ root, log, sources, now, records, write })
    } finally {
      if (previous === undefined) delete process.env.DERIVE_CONFIG_DIR
      else process.env.DERIVE_CONFIG_DIR = previous
    }
  }

  it("preserves malformed artifact spools instead of replacing pending receipts", async () => {
    await scanFixture(({ root }) => {
      const path = join(root, "artifact-scan-spool.json")
      for (const contents of ["{broken", "null", "[]", '{"pending":[]}']) {
        writeFileSync(path, contents)
        expect(() => addToArtifactScanSpool([], [], {})).toThrow("cannot read artifact scan spool")
        expect(readFileSync(path, "utf8")).toBe(contents)
      }
    })
  })

  for (const [label, scan] of [
    ["artifact", scanArtifactLogs],
    ["Skill", scanSkillLogs],
  ]) {
    it(`keeps an existing ${label} cursor and pending events when setup runs again`, async () => {
      await scanFixture(async ({ root, sources, records, write, now }) => {
        write(records())
        await scan({ sources, now, baseline: true })
        const stateFile = join(
          root,
          label === "artifact" ? "artifact-scan.json" : "skill-scan.json",
        )
        const initialSources = JSON.parse(readFileSync(stateFile, "utf8")).sources
        write(records(), true)
        await scan({ sources, now, baseline: true })
        expect(JSON.parse(readFileSync(stateFile, "utf8")).sources).toEqual(initialSources)
      })
    })
  }

  it("ignores other services' read tools and failed Derive results", async () => {
    await scanFixture(async ({ sources, write, records, now }) => {
      for (const [name, output] of [
        ["mcp__other__read", { short_id: "scan1234", version: 2 }],
        ["mcp__derive__publish", { published: false, short_id: "scan1234", version: 2 }],
        [
          "mcp__derive__read",
          {
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ short_id: "scan1234", version: 2 }) }],
          },
        ],
        ["mcp__derive__read", { short_id: "scan1234", version: "2oops" }],
      ]) {
        write(records(name, output))
        expect(
          (await scanArtifactLogs({ sources, now, since: "30d", dryRun: true })).events,
        ).toEqual([])
      }
    })
  })

  it("extracts receipts inside named orchestration results", async () => {
    await scanFixture(async ({ sources, write, records, now }) => {
      const rows = records("exec", {
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ short_id: "scan1234", version: "2 (current)" }),
            },
          ],
        },
      })
      rows[1].payload.arguments =
        'text({ result: await tools.mcp__derive__read({ short_id: "scan1234" }) })'
      write(rows)
      expect((await scanArtifactLogs({ sources, now, since: "30d" })).events).toEqual([
        expect.objectContaining({
          artifact_short_id: "scan1234",
          artifact_version: 2,
          action: "read",
        }),
      ])
    })
  })

  it("recognizes bulk reads through Derive code mode", async () => {
    await scanFixture(async ({ sources, write, records, now }) => {
      write(
        records("mcp__derive__derive_code", {
          result: { results: [{ index: 0, value: { short_id: "scan1234", version: 2 } }] },
          tool_calls: ["read"],
        }),
      )
      expect((await scanArtifactLogs({ sources, now, since: "30d" })).events).toEqual([
        expect.objectContaining({ artifact_short_id: "scan1234", artifact_version: 2 }),
      ])
      write(
        records("mcp__derive__derive_code", {
          result: "---\nshort_id: scan1234\nversion: 2 (current)\n---\n# A read",
          tool_calls: ["read"],
        }),
      )
      expect((await scanArtifactLogs({ sources, now, since: "30d" })).events).toHaveLength(1)
      write(
        records("mcp__derive__derive_code", {
          result: [{ type: "artifact", short_id: "scan1234", version: 2 }],
          tool_calls: ["find"],
        }),
      )
      expect((await scanArtifactLogs({ sources, now, since: "30d" })).events).toEqual([])
    })
  })

  it("excludes a second writer until the first scan releases its lock", async () => {
    await scanFixture(() => {
      const release = acquireScanLock("artifact")
      try {
        expect(() => acquireScanLock("artifact")).toThrow("scan is locked")
        const releaseSkill = acquireScanLock("skill")
        releaseSkill()
      } finally {
        release()
      }
      const retry = acquireScanLock("artifact")
      retry()
    })
  })

  it("keeps pending receipts bound to their original server during a backfill", async () => {
    await scanFixture(() => {
      const original = { server: "https://first.derive.test", account_id: "first" }
      const other = { server: "https://other.derive.test", account_id: "other" }
      const event = { event_id: "a".repeat(64), artifact_short_id: "scan1234" }
      addToArtifactScanSpool([event], [], original)
      const replay = addToArtifactScanSpool([event], [], other)
      expect(replay.pending).toEqual([{ ...event, target: original }])
    })
  })

  it("replays replaced Skill logs and keeps turn changes across JSON formatting", async () => {
    await scanFixture(async ({ root, log, sources, now, write }) => {
      const skill = {
        id: "skill123",
        version: 1,
        name: "review",
        client: "codex",
        path: join(root, "review"),
        server: "https://derive.test",
      }
      const options = { sources, now, installs: [skill] }
      write([{ type: "session_meta", payload: { id: "old" } }])
      await scanSkillLogs(options)
      const rows = [
        { type: "session_meta", payload: { id: "replacement-with-a-longer-name" } },
        { type: "event_msg", payload: { turn_id: "new-turn" } },
        {
          type: "response_item",
          timestamp: "2026-09-07T12:00:00.000Z",
          payload: {
            type: "function_call",
            call_id: "file-read",
            arguments: JSON.stringify({ cmd: `cat ${skill.path}/SKILL.md` }),
          },
        },
      ]
      writeFileSync(
        log,
        `${rows.map((row) => JSON.stringify(row).replaceAll('":', '": ')).join("\n")}\n`,
      )
      const result = await scanSkillLogs(options)
      expect(result.events).toHaveLength(1)
      expect(result.state.sources[log].turn).toBe("new-turn")
      expect(result.state.sources[log].session).toBe("replacement-with-a-longer-name")
    })
  })

  it("does not treat undated Skill activity as recent during a backfill", async () => {
    await scanFixture(async ({ root, sources, now, write }) => {
      const skill = {
        id: "skill123",
        version: 1,
        client: "codex",
        path: join(root, "review"),
        server: "https://derive.test",
      }
      write([
        {
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "undated",
            arguments: JSON.stringify({ cmd: `cat ${skill.path}/SKILL.md` }),
          },
        },
      ])
      expect(
        (await scanSkillLogs({ sources, now, installs: [skill], since: "30d" })).events,
      ).toEqual([])
    })
  })

  it("records exact Codex and Claude artifact results without content or local identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "derive-artifact-scan-"))
    dirs.push(root)
    const home = join(root, "home")
    const config = join(root, "config")
    const priorConfig = process.env.DERIVE_CONFIG_DIR
    process.env.DERIVE_CONFIG_DIR = config
    try {
      const codexLog = join(home, ".codex", "sessions", "session-a.jsonl")
      mkdirSync(join(home, ".codex", "sessions"), { recursive: true })
      writeFileSync(
        codexLog,
        `${[
          {
            type: "session_meta",
            timestamp: "2026-09-05T12:00:00.000Z",
            payload: { id: "private-codex-session" },
          },
          {
            type: "response_item",
            timestamp: "2026-09-05T12:01:00.000Z",
            payload: {
              type: "custom_tool_call",
              name: "exec",
              call_id: "read-call",
              input: 'const r = await tools.mcp__derive__read({short_id:"graph123"})',
            },
          },
          {
            type: "response_item",
            timestamp: "2026-09-05T12:01:01.000Z",
            payload: {
              type: "custom_tool_call_output",
              call_id: "read-call",
              output: [
                {
                  type: "input_text",
                  text: JSON.stringify({
                    type: "text",
                    text: JSON.stringify({
                      short_id: "graph123",
                      version: 4,
                      title: "Private source text must not upload",
                    }),
                  }),
                },
              ],
            },
          },
          {
            type: "response_item",
            timestamp: "2026-09-05T12:01:02.000Z",
            payload: {
              type: "function_call",
              name: "mcp__derive__catch_up",
              call_id: "catch-up-call",
              arguments: JSON.stringify({ short_id: "graph123" }),
            },
          },
          {
            type: "response_item",
            timestamp: "2026-09-05T12:01:03.000Z",
            payload: {
              type: "function_call_output",
              call_id: "catch-up-call",
              output: JSON.stringify({ short_id: "graph123", from: 4, to: 5 }),
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n")}\n`,
      )
      const claudeLog = join(home, ".claude", "projects", "project-a", "session-b.jsonl")
      mkdirSync(join(home, ".claude", "projects", "project-a"), { recursive: true })
      writeFileSync(
        claudeLog,
        `${[
          {
            type: "assistant",
            timestamp: "2026-09-05T12:02:00.000Z",
            sessionId: "private-claude-session",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "publish-call",
                  name: "mcp__derive__publish",
                  input: { title: "Must stay local", content: "secret body" },
                },
              ],
            },
          },
          {
            type: "user",
            timestamp: "2026-09-05T12:02:01.000Z",
            sessionId: "private-claude-session",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "publish-call",
                  content: JSON.stringify({ published: true, short_id: "output456", version: 2 }),
                },
              ],
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n")}\n`,
      )

      const result = await scanArtifactLogs({
        home,
        since: "30d",
        now: Date.parse("2026-09-06"),
      })
      expect(result.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            artifact_short_id: "graph123",
            artifact_version: 4,
            action: "read",
            client: "codex",
          }),
          expect.objectContaining({
            artifact_short_id: "output456",
            artifact_version: 2,
            action: "published",
            client: "claude",
          }),
          expect.objectContaining({
            artifact_short_id: "graph123",
            artifact_version: 5,
            action: "read",
            client: "codex",
          }),
        ]),
      )
      const serialized = JSON.stringify(result.events)
      expect(serialized).not.toContain("private-codex-session")
      expect(serialized).not.toContain("private-claude-session")
      expect(serialized).not.toContain("secret body")
      expect(serialized).not.toContain("Private source text")
      expect((await scanArtifactLogs({ home })).events).toEqual([])
    } finally {
      if (priorConfig === undefined) delete process.env.DERIVE_CONFIG_DIR
      else process.env.DERIVE_CONFIG_DIR = priorConfig
    }
  })

  it("keeps an unmatched tool call until its result is appended", async () => {
    const root = mkdtempSync(join(tmpdir(), "derive-artifact-scan-pending-"))
    dirs.push(root)
    const home = join(root, "home")
    const config = join(root, "config")
    const priorConfig = process.env.DERIVE_CONFIG_DIR
    process.env.DERIVE_CONFIG_DIR = config
    try {
      const log = join(home, ".codex", "sessions", "session.jsonl")
      mkdirSync(join(home, ".codex", "sessions"), { recursive: true })
      writeFileSync(
        log,
        `${JSON.stringify({
          type: "session_meta",
          payload: { id: "session-pending" },
        })}\n${JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "mcp__derive__publish",
            call_id: "publish-pending",
            arguments: JSON.stringify({ content: "never uploaded" }),
          },
        })}\n`,
      )
      expect((await scanArtifactLogs({ home, initialBaseline: false })).events).toEqual([])
      writeFileSync(
        log,
        `${JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "publish-pending",
            output: JSON.stringify({ published: true, short_id: "later789", version: 3 }),
          },
        })}\n`,
        { flag: "a" },
      )
      expect((await scanArtifactLogs({ home })).events).toEqual([
        expect.objectContaining({
          artifact_short_id: "later789",
          artifact_version: 3,
          action: "published",
        }),
      ])
    } finally {
      if (priorConfig === undefined) delete process.env.DERIVE_CONFIG_DIR
      else process.env.DERIVE_CONFIG_DIR = priorConfig
    }
  })

  it("does not advance its cursor before the caller durably spools a receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "derive-artifact-scan-checkpoint-"))
    dirs.push(root)
    const home = join(root, "home")
    const config = join(root, "config")
    const priorConfig = process.env.DERIVE_CONFIG_DIR
    process.env.DERIVE_CONFIG_DIR = config
    try {
      const log = join(home, ".codex", "sessions", "session.jsonl")
      mkdirSync(join(home, ".codex", "sessions"), { recursive: true })
      writeFileSync(
        log,
        `${[
          {
            type: "session_meta",
            timestamp: "2026-09-07T12:00:00.000Z",
            payload: { id: "checkpoint-session" },
          },
          {
            type: "response_item",
            timestamp: "2026-09-07T12:00:01.000Z",
            payload: {
              type: "function_call",
              name: "mcp__derive__read",
              call_id: "checkpoint-read",
              arguments: "{}",
            },
          },
          {
            type: "response_item",
            timestamp: "2026-09-07T12:00:02.000Z",
            payload: {
              type: "function_call_output",
              call_id: "checkpoint-read",
              output: JSON.stringify({ short_id: "retry123", version: 2 }),
            },
          },
        ]
          .map(JSON.stringify)
          .join("\n")}\n`,
      )
      const interrupted = await scanArtifactLogs({
        home,
        now: Date.parse("2026-09-08"),
        deferCommit: true,
        initialBaseline: false,
      })
      expect(interrupted.events).toHaveLength(1)
      const replayed = await scanArtifactLogs({
        home,
        now: Date.parse("2026-09-08"),
        deferCommit: true,
        initialBaseline: false,
      })
      expect(replayed.events).toEqual(interrupted.events)
      commitArtifactScanState(replayed.state)
      expect((await scanArtifactLogs({ home })).events).toEqual([])
    } finally {
      if (priorConfig === undefined) delete process.env.DERIVE_CONFIG_DIR
      else process.env.DERIVE_CONFIG_DIR = priorConfig
    }
  })

  it("keeps reused call ids separate across session files", async () => {
    const root = mkdtempSync(join(tmpdir(), "derive-artifact-scan-call-id-"))
    dirs.push(root)
    const home = join(root, "home")
    const config = join(root, "config")
    const priorConfig = process.env.DERIVE_CONFIG_DIR
    process.env.DERIVE_CONFIG_DIR = config
    try {
      const first = join(home, "first.jsonl")
      const second = join(home, "second.jsonl")
      mkdirSync(home, { recursive: true })
      const call = (session) => [
        { type: "session_meta", payload: { id: session } },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "mcp__derive__read",
            call_id: "shared-call-id",
            arguments: "{}",
          },
        },
      ]
      writeFileSync(first, `${call("first-session").map(JSON.stringify).join("\n")}\n`)
      writeFileSync(
        second,
        `${[
          ...call("second-session"),
          {
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "shared-call-id",
              output: JSON.stringify({ short_id: "second123", version: 1 }),
            },
          },
        ]
          .map(JSON.stringify)
          .join("\n")}\n`,
      )
      const initial = await scanArtifactLogs({
        home,
        sources: [
          { client: "codex", path: first },
          { client: "codex", path: second },
        ],
        initialBaseline: false,
      })
      expect(initial.events).toEqual([expect.objectContaining({ artifact_short_id: "second123" })])
      writeFileSync(
        first,
        `${JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "shared-call-id",
            output: JSON.stringify({ short_id: "first123", version: 1 }),
          },
        })}\n`,
        { flag: "a" },
      )
      expect(
        (
          await scanArtifactLogs({
            home,
            sources: [
              { client: "codex", path: first },
              { client: "codex", path: second },
            ],
          })
        ).events,
      ).toEqual([expect.objectContaining({ artifact_short_id: "first123" })])
    } finally {
      if (priorConfig === undefined) delete process.env.DERIVE_CONFIG_DIR
      else process.env.DERIVE_CONFIG_DIR = priorConfig
    }
  })

  it("replays a copytruncated source that regrows past its cursor", async () => {
    const root = mkdtempSync(join(tmpdir(), "derive-artifact-scan-copytruncate-"))
    dirs.push(root)
    const home = join(root, "home")
    const config = join(root, "config")
    const priorConfig = process.env.DERIVE_CONFIG_DIR
    process.env.DERIVE_CONFIG_DIR = config
    try {
      const log = join(home, "session.jsonl")
      mkdirSync(home, { recursive: true })
      writeFileSync(log, `${JSON.stringify({ type: "session_meta", payload: { id: "old" } })}\n`)
      await scanArtifactLogs({
        home,
        sources: [{ client: "codex", path: log }],
        initialBaseline: false,
      })
      const replacement = [
        { type: "session_meta", payload: { id: "replacement-session-with-a-long-name" } },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "mcp__derive__read",
            call_id: "replacement-read",
            arguments: "{}",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "replacement-read",
            output: JSON.stringify({ short_id: "replace1", version: 3 }),
          },
        },
      ]
      writeFileSync(log, `${replacement.map(JSON.stringify).join("\n")}\n`)
      expect(
        (await scanArtifactLogs({ home, sources: [{ client: "codex", path: log }] })).events,
      ).toEqual([expect.objectContaining({ artifact_short_id: "replace1", artifact_version: 3 })])
    } finally {
      if (priorConfig === undefined) delete process.env.DERIVE_CONFIG_DIR
      else process.env.DERIVE_CONFIG_DIR = priorConfig
    }
  })

  it("applies since to each event in a recently modified log", async () => {
    const root = mkdtempSync(join(tmpdir(), "derive-artifact-scan-since-"))
    dirs.push(root)
    const home = join(root, "home")
    const config = join(root, "config")
    const priorConfig = process.env.DERIVE_CONFIG_DIR
    process.env.DERIVE_CONFIG_DIR = config
    try {
      const log = join(home, ".codex", "sessions", "session.jsonl")
      mkdirSync(join(home, ".codex", "sessions"), { recursive: true })
      const records = (callId, timestamp, shortId) => [
        {
          type: "response_item",
          timestamp,
          payload: {
            type: "function_call",
            name: "mcp__derive__read",
            call_id: callId,
            arguments: "{}",
          },
        },
        {
          type: "response_item",
          timestamp,
          payload: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify({ short_id: shortId, version: 1 }),
          },
        },
      ]
      writeFileSync(
        log,
        `${[
          ...records("old", "2026-01-01T00:00:00.000Z", "old12345"),
          ...records("new", "2026-09-07T00:00:00.000Z", "new12345"),
        ]
          .map(JSON.stringify)
          .join("\n")}\n`,
      )
      expect(
        (
          await scanArtifactLogs({
            home,
            now: Date.parse("2026-09-08"),
          })
        ).events,
      ).toEqual([])
      const result = await scanArtifactLogs({
        home,
        since: "30d",
        now: Date.parse("2026-09-08"),
      })
      expect(result.events.map((event) => event.artifact_short_id)).toEqual(["new12345"])
    } finally {
      if (priorConfig === undefined) delete process.env.DERIVE_CONFIG_DIR
      else process.env.DERIVE_CONFIG_DIR = priorConfig
    }
  })

  it("reads a new client log after the initial baseline", async () => {
    const root = mkdtempSync(join(tmpdir(), "derive-artifact-scan-new-client-"))
    dirs.push(root)
    const home = join(root, "home")
    const config = join(root, "config")
    const priorConfig = process.env.DERIVE_CONFIG_DIR
    process.env.DERIVE_CONFIG_DIR = config
    try {
      const codexLog = join(home, ".codex", "sessions", "existing.jsonl")
      mkdirSync(join(home, ".codex", "sessions"), { recursive: true })
      writeFileSync(codexLog, `${JSON.stringify({ type: "session_meta" })}\n`)
      await scanArtifactLogs({ home })

      const claudeLog = join(home, ".claude", "projects", "new", "session.jsonl")
      mkdirSync(join(home, ".claude", "projects", "new"), { recursive: true })
      writeFileSync(
        claudeLog,
        `${[
          {
            type: "assistant",
            timestamp: "2026-09-07T12:02:00.000Z",
            sessionId: "new-claude-session",
            message: {
              content: [{ type: "tool_use", id: "new-read", name: "mcp__derive__read", input: {} }],
            },
          },
          {
            type: "user",
            timestamp: "2026-09-07T12:02:01.000Z",
            sessionId: "new-claude-session",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "new-read",
                  content: JSON.stringify({ short_id: "new12345", version: 2 }),
                },
              ],
            },
          },
        ]
          .map(JSON.stringify)
          .join("\n")}\n`,
      )
      expect((await scanArtifactLogs({ home })).events).toEqual([
        expect.objectContaining({
          artifact_short_id: "new12345",
          artifact_version: 2,
          client: "claude",
        }),
      ])
    } finally {
      if (priorConfig === undefined) delete process.env.DERIVE_CONFIG_DIR
      else process.env.DERIVE_CONFIG_DIR = priorConfig
    }
  })

  it("baselines each client when a filtered scan reaches it first", async () => {
    const root = mkdtempSync(join(tmpdir(), "derive-artifact-scan-client-baseline-"))
    dirs.push(root)
    const home = join(root, "home")
    const config = join(root, "config")
    const priorConfig = process.env.DERIVE_CONFIG_DIR
    process.env.DERIVE_CONFIG_DIR = config
    try {
      const codexLog = join(home, ".codex", "sessions", "codex.jsonl")
      const claudeLog = join(home, ".claude", "projects", "old", "claude.jsonl")
      mkdirSync(join(home, ".codex", "sessions"), { recursive: true })
      mkdirSync(join(home, ".claude", "projects", "old"), { recursive: true })
      writeFileSync(codexLog, `${JSON.stringify({ type: "session_meta" })}\n`)
      writeFileSync(
        claudeLog,
        `${[
          {
            type: "assistant",
            timestamp: "2026-09-07T12:00:00.000Z",
            sessionId: "old-claude-session",
            message: {
              content: [{ type: "tool_use", id: "old-read", name: "mcp__derive__read" }],
            },
          },
          {
            type: "user",
            timestamp: "2026-09-07T12:00:01.000Z",
            sessionId: "old-claude-session",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "old-read",
                  content: JSON.stringify({ short_id: "old12345", version: 1 }),
                },
              ],
            },
          },
        ]
          .map(JSON.stringify)
          .join("\n")}\n`,
      )

      expect((await scanArtifactLogs({ home, client: "codex" })).events).toEqual([])
      expect((await scanArtifactLogs({ home })).events).toEqual([])
      writeFileSync(
        claudeLog,
        `${[
          {
            type: "assistant",
            timestamp: "2026-09-07T12:01:00.000Z",
            sessionId: "old-claude-session",
            message: {
              content: [{ type: "tool_use", id: "new-read", name: "mcp__derive__read" }],
            },
          },
          {
            type: "user",
            timestamp: "2026-09-07T12:01:01.000Z",
            sessionId: "old-claude-session",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "new-read",
                  content: JSON.stringify({ short_id: "new12345", version: 2 }),
                },
              ],
            },
          },
        ]
          .map(JSON.stringify)
          .join("\n")}\n`,
        { flag: "a" },
      )
      expect((await scanArtifactLogs({ home })).events).toEqual([
        expect.objectContaining({ artifact_short_id: "new12345", client: "claude" }),
      ])
    } finally {
      if (priorConfig === undefined) delete process.env.DERIVE_CONFIG_DIR
      else process.env.DERIVE_CONFIG_DIR = priorConfig
    }
  })

  it("replaces the narrow Skill hook with one generic session-end scan", () => {
    const home = mkdtempSync(join(tmpdir(), "derive-scan-setup-"))
    dirs.push(home)
    const hooks = join(home, ".codex", "hooks.json")
    mkdirSync(join(home, ".codex"), { recursive: true })
    writeFileSync(
      hooks,
      JSON.stringify({
        hooks: {
          SessionEnd: [
            {
              hooks: [
                {
                  type: "command",
                  command: '"/usr/bin/node" "/derive.js" skill scan --quiet',
                  async: true,
                },
              ],
            },
          ],
        },
      }),
    )
    const result = setupDeriveScan({
      home,
      node: "/usr/bin/node",
      cli: "/derive.js",
      client: "codex",
      activate: false,
    })
    expect(result.hooks[0].changed).toBe(true)
    const config = JSON.parse(readFileSync(hooks, "utf8"))
    expect(config.hooks.SessionEnd).toHaveLength(1)
    expect(config.hooks.SessionEnd[0].hooks[0].command).toBe(
      '"/usr/bin/node" "/derive.js" scan --quiet --client codex',
    )
    expect(config.hooks.SessionEnd[0].hooks[0].timeout).toBe(300)
    expect(
      setupDeriveScan({
        home,
        node: "/usr/bin/node",
        cli: "/derive.js",
        client: "codex",
        activate: false,
      }).hooks[0].changed,
    ).toBe(false)
  })

  it("previews legacy project pins without creating or changing local scan state", async () => {
    const project = mkdtempSync(join(tmpdir(), "derive-scan-preview-"))
    dirs.push(project)
    const home = join(project, "home")
    const skillPath = join(project, ".agents", "skills", "Review")
    mkdirSync(skillPath, { recursive: true })
    writeFileSync(
      join(project, "derive.json"),
      JSON.stringify({
        entry: "index.md",
        skills: [
          { id: "review123", version: 2, name: "Review", installs: { codex: { version: 2 } } },
        ],
      }),
    )
    const logs = join(home, ".codex", "sessions")
    mkdirSync(logs, { recursive: true })
    writeFileSync(
      join(logs, "preview.jsonl"),
      `${JSON.stringify({ type: "response_item", timestamp: new Date().toISOString(), payload: { type: "function_call", call_id: "preview", arguments: JSON.stringify({ cmd: `cat ${skillPath}/SKILL.md` }) } })}\n`,
    )
    for (const command of [["skill", "scan"], ["scan"]]) {
      const result = await run(
        project,
        "https://derive.test",
        [...command, "--dry-run", "--since", "30d", "--json"],
        { HOME: home },
      )
      expect(result.status).toBe(0)
      const parsed = JSON.parse(result.stdout)
      expect(parsed.events ?? parsed.skills).toEqual([
        expect.objectContaining({ skill_short_id: "review123", skill_version: 2 }),
      ])
      expect(existsSync(join(project, ".derive-test-config"))).toBe(false)
    }
    const status = await run(
      project,
      "https://derive.test",
      ["skill", "scan", "status", "--json"],
      { HOME: home },
    )
    expect(status.status).toBe(0)
    expect(existsSync(join(project, ".derive-test-config"))).toBe(false)
  })

  it("retains a failed upload batch and retries it without rescanning receipts", async () => {
    const project = mkdtempSync(join(tmpdir(), "derive-scan-batch-retry-"))
    dirs.push(project)
    const home = join(project, "home")
    let fail = true
    const batches = []
    const server = http.createServer((request, response) => {
      if (request.url === "/v1/workspaces") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ workspaces: [] }))
        return
      }
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        const parsed = JSON.parse(body)
        batches.push(parsed.events.length)
        if (fail && batches.length === 2) {
          response.writeHead(503)
          response.end("temporary outage")
        } else {
          response.writeHead(200, { "content-type": "application/json" })
          response.end(
            JSON.stringify({
              recorded: parsed.events.map((event) => event.event_id),
              rejected: [],
            }),
          )
        }
      })
    })
    servers.push(server)
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const logs = join(home, ".codex", "sessions")
    mkdirSync(logs, { recursive: true })
    const timestamp = new Date().toISOString()
    const rows = Array.from({ length: 21 }, (_, index) => [
      {
        type: "response_item",
        timestamp,
        payload: {
          type: "function_call",
          name: "mcp__derive__read",
          call_id: `read-${index}`,
          arguments: "{}",
        },
      },
      {
        type: "response_item",
        timestamp,
        payload: {
          type: "function_call_output",
          call_id: `read-${index}`,
          output: JSON.stringify({ short_id: "read1234", version: 1 }),
        },
      },
    ]).flat()
    writeFileSync(
      join(logs, "batch.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    )
    const first = await run(project, base, ["scan", "--since", "30d", "--quiet", "--json"], {
      HOME: home,
    })
    expect(first.status).toBe(1)
    expect(JSON.parse(first.stdout).artifacts).toMatchObject({
      found: 21,
      uploaded: 20,
      pending: 1,
    })
    fail = false
    const retry = await run(project, base, ["scan", "--json"], { HOME: home })
    expect(retry.status).toBe(0)
    expect(JSON.parse(retry.stdout).artifacts).toMatchObject({ found: 0, uploaded: 1, pending: 0 })
    expect(batches).toEqual([20, 1, 1])
    expect(existsSync(join(project, ".derive-test-config", "artifact-scan.lock"))).toBe(false)
    expect(existsSync(join(project, ".derive-test-config", "skill-scan.lock"))).toBe(false)
  })

  it("baselines both scanners on the first generic command", async () => {
    const project = mkdtempSync(join(tmpdir(), "derive-generic-scan-baseline-"))
    dirs.push(project)
    const home = join(project, "home")
    const received = []
    const server = http.createServer((request, response) => {
      if (request.url === "/v1/workspaces") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ workspaces: [] }))
        return
      }
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        received.push({ path: request.url, body: JSON.parse(body || "{}") })
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ recorded: [], rejected: [], coverage: 1 }))
      })
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    servers.push(server)
    const base = `http://127.0.0.1:${server.address().port}`
    const log = join(home, ".codex", "sessions", "session.jsonl")
    mkdirSync(join(home, ".codex", "sessions"), { recursive: true })
    writeFileSync(
      log,
      `${JSON.stringify({
        type: "response_item",
        timestamp: new Date().toISOString(),
        payload: {
          type: "function_call_output",
          call_id: "old-read",
          output: JSON.stringify({ short_id: "artifact123", version: 1 }),
        },
      })}\n`,
    )

    const result = await run(project, base, ["scan", "--json"], { HOME: home })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      artifacts: { found: 0, uploaded: 0, rejected: 0, pending: 0 },
      skills: { found: 0, uploaded: 0, pending: 0 },
    })
    expect(received).toEqual([
      expect.objectContaining({
        path: "/v1/artifact-scan/batch",
        body: { events: [], coverage: [expect.objectContaining({ client: "codex" })] },
      }),
    ])
  })

  it("uploads generic artifact receipts and removes accepted events from the spool", async () => {
    const project = mkdtempSync(join(tmpdir(), "derive-generic-scan-upload-"))
    dirs.push(project)
    const home = join(project, "home")
    const received = []
    const server = http.createServer((request, response) => {
      if (request.url === "/v1/workspaces") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ workspaces: [] }))
        return
      }
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        const parsed = JSON.parse(body || "{}")
        received.push({ path: request.url, body: parsed })
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            recorded: (parsed.events ?? []).map((event) => event.event_id),
            rejected: [],
            coverage: parsed.coverage?.length ?? 0,
          }),
        )
      })
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    servers.push(server)
    const base = `http://127.0.0.1:${server.address().port}`
    const log = join(home, ".codex", "sessions", "session.jsonl")
    mkdirSync(join(home, ".codex", "sessions"), { recursive: true })
    writeFileSync(
      log,
      `${JSON.stringify({
        type: "session_meta",
        timestamp: new Date().toISOString(),
        payload: { id: "upload-session" },
      })}\n${JSON.stringify({
        type: "response_item",
        timestamp: new Date().toISOString(),
        payload: {
          type: "function_call",
          name: "mcp__derive__read",
          call_id: "upload-read",
          arguments: "{}",
        },
      })}\n${JSON.stringify({
        type: "response_item",
        timestamp: new Date().toISOString(),
        payload: {
          type: "function_call_output",
          call_id: "upload-read",
          output: JSON.stringify({ short_id: "artifact123", version: 7 }),
        },
      })}\n`,
    )

    const result = await run(project, base, ["scan", "--since", "30d", "--json"], {
      HOME: home,
    })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      artifacts: { found: 1, uploaded: 1, pending: 0 },
    })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      path: "/v1/artifact-scan/batch",
      body: {
        events: [
          expect.objectContaining({
            artifact_short_id: "artifact123",
            artifact_version: 7,
            action: "read",
          }),
        ],
      },
    })
    expect(JSON.stringify(received[0])).not.toContain("upload-session")
  })

  it("probes eligible workspaces before settling an artifact receipt", async () => {
    const project = mkdtempSync(join(tmpdir(), "derive-generic-scan-workspaces-"))
    dirs.push(project)
    const home = join(project, "home")
    const attempts = []
    const server = http.createServer((request, response) => {
      if (request.url === "/v1/workspaces") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            active: "workspace-a",
            workspaces: [
              { id: "workspace-a", name: "A", role: "owner" },
              { id: "workspace-b", name: "B", role: "owner" },
            ],
          }),
        )
        return
      }
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        const parsed = JSON.parse(body || "{}")
        const workspace = request.headers["x-derive-workspace"]
        attempts.push({
          workspace,
          events: parsed.events.length,
          coverage: parsed.coverage.length,
        })
        const ids = parsed.events.map((event) => event.event_id)
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify(
            workspace === "workspace-b"
              ? { recorded: ids, rejected: [], coverage: parsed.coverage.length }
              : {
                  recorded: [],
                  rejected: ids.map((event_id) => ({
                    event_id,
                    reason: "artifact_unavailable",
                  })),
                  coverage: parsed.coverage.length,
                },
          ),
        )
      })
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    servers.push(server)
    const base = `http://127.0.0.1:${server.address().port}`
    const log = join(home, ".codex", "sessions", "session.jsonl")
    mkdirSync(join(home, ".codex", "sessions"), { recursive: true })
    writeFileSync(
      log,
      `${[
        {
          type: "session_meta",
          timestamp: new Date().toISOString(),
          payload: { id: "workspace-session" },
        },
        {
          type: "response_item",
          timestamp: new Date().toISOString(),
          payload: {
            type: "function_call",
            name: "mcp__derive__read",
            call_id: "workspace-read",
            arguments: "{}",
          },
        },
        {
          type: "response_item",
          timestamp: new Date().toISOString(),
          payload: {
            type: "function_call_output",
            call_id: "workspace-read",
            output: JSON.stringify({ short_id: "workspace123", version: 1 }),
          },
        },
      ]
        .map(JSON.stringify)
        .join("\n")}\n`,
    )

    const result = await run(project, base, ["scan", "--since", "30d", "--json"], {
      HOME: home,
    })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).artifacts).toEqual({
      found: 1,
      uploaded: 1,
      rejected: 0,
      pending: 0,
    })
    expect(attempts).toEqual([
      { workspace: "workspace-a", events: 1, coverage: 1 },
      { workspace: "workspace-b", events: 1, coverage: 0 },
    ])
  })

  it("does not send an unavailable receipt to another server", async () => {
    const project = mkdtempSync(join(tmpdir(), "derive-generic-scan-server-retry-"))
    dirs.push(project)
    const home = join(project, "home")
    const received = []
    let firstAvailable = false
    const makeServer = (workspace, accepts) =>
      http.createServer((request, response) => {
        if (request.url === "/v1/workspaces") {
          response.writeHead(200, { "content-type": "application/json" })
          response.end(
            JSON.stringify({
              active: workspace,
              workspaces: [{ id: workspace, name: workspace, role: "owner" }],
            }),
          )
          return
        }
        let body = ""
        request.on("data", (chunk) => (body += chunk))
        request.on("end", () => {
          const parsed = JSON.parse(body || "{}")
          received.push({ workspace, count: parsed.events.length })
          const ids = parsed.events.map((event) => event.event_id)
          response.writeHead(200, { "content-type": "application/json" })
          response.end(
            JSON.stringify(
              accepts || (workspace === "workspace-a" && firstAvailable)
                ? { recorded: ids, rejected: [], coverage: parsed.coverage.length }
                : {
                    recorded: [],
                    rejected: ids.map((event_id) => ({
                      event_id,
                      reason: "artifact_unavailable",
                    })),
                    coverage: parsed.coverage.length,
                  },
            ),
          )
        })
      })
    const firstServer = makeServer("workspace-a", false)
    const secondServer = makeServer("workspace-b", true)
    await new Promise((resolve) => firstServer.listen(0, "127.0.0.1", resolve))
    await new Promise((resolve) => secondServer.listen(0, "127.0.0.1", resolve))
    servers.push(firstServer, secondServer)
    const firstBase = `http://127.0.0.1:${firstServer.address().port}`
    const secondBase = `http://127.0.0.1:${secondServer.address().port}`
    const log = join(home, ".codex", "sessions", "session.jsonl")
    mkdirSync(join(home, ".codex", "sessions"), { recursive: true })
    const timestamp = new Date().toISOString()
    writeFileSync(
      log,
      `${[
        { type: "session_meta", timestamp, payload: { id: "cross-server-session" } },
        {
          type: "response_item",
          timestamp,
          payload: {
            type: "function_call",
            name: "mcp__derive__read",
            call_id: "cross-server-read",
            arguments: "{}",
          },
        },
        {
          type: "response_item",
          timestamp,
          payload: {
            type: "function_call_output",
            call_id: "cross-server-read",
            output: JSON.stringify({ short_id: "server123", version: 1 }),
          },
        },
      ]
        .map(JSON.stringify)
        .join("\n")}\n`,
    )

    const first = await run(project, firstBase, ["scan", "--since", "30d", "--json"], {
      HOME: home,
    })
    expect(first.status).toBe(0)
    expect(JSON.parse(first.stdout).artifacts).toMatchObject({ uploaded: 0, pending: 1 })
    const second = await run(project, secondBase, ["scan", "--json"], { HOME: home })
    expect(second.status).toBe(0)
    expect(JSON.parse(second.stdout).artifacts).toMatchObject({
      found: 0,
      uploaded: 0,
      pending: 1,
    })
    expect(
      received.filter((item) => item.workspace === "workspace-b").every((item) => item.count === 0),
    ).toBe(true)
    firstAvailable = true
    const third = await run(project, firstBase, ["scan", "--json"], { HOME: home })
    expect(JSON.parse(third.stdout).artifacts).toMatchObject({ found: 0, uploaded: 1, pending: 0 })
  })
})

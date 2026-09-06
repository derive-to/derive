import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { recordSkillInstall, scanSkillLogs } from "../src/skill-scan.js"
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

  it("uploads scanned receipts and coverage as one batch", async () => {
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
    writeFileSync(
      log,
      `${JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        sessionId: "session-a",
        attributionSkill: "review-skill",
      })}\n`,
    )

    const result = await run(project, base, ["skill", "scan", "--since", "30d", "--json"], {
      HOME: home,
    })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ found: 1, uploaded: 1, pending: 0 })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      uses: [
        expect.objectContaining({
          skill_short_id: "review123",
          client: "claude",
          evidence: "structured_log",
        }),
      ],
      coverage: [expect.objectContaining({ client: "claude", sessions_scanned: 1 })],
    })
  })
})

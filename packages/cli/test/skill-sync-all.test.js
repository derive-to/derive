import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { commitArtifactScanState, scanArtifactLogs } from "../src/artifact-scan.js"
import { setupDeriveScan } from "../src/derive-scan-setup.js"
import { lockScan } from "../src/scan-lock.js"
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
  it("shows bounded pending receipt details without exposing local identity", async () => {
    const project = mkdtempSync(join(tmpdir(), "derive-scan-status-details-"))
    dirs.push(project)
    const config = join(project, ".derive-test-config")
    mkdirSync(config, { recursive: true })
    const contents = JSON.stringify({
      version: 1,
      coverage: [],
      pending: Array.from({ length: 23 }, (_, index) => ({
        event_id: index.toString(16).padStart(64, "0"),
        artifact_short_id: `pending${index}`,
        artifact_version: 2,
        action: "read",
        client: "codex",
        occurred_at: "2026-09-08T01:00:00.000Z",
        retry_unavailable: index < 3,
        opaque_session_id: "private-session-marker",
        target: { server: "https://derive.test", account_id: "private-account-marker" },
      })),
    })
    const spool = join(config, "artifact-scan-spool.json")
    writeFileSync(spool, contents)
    const result = await run(project, "http://127.0.0.1:1", ["scan", "status", "--json"], {
      HOME: join(project, "home"),
    })
    expect(result.status).toBe(0)
    const status = JSON.parse(result.stdout).artifacts
    expect(status.pending).toBe(23)
    expect(status.pending_by_reason).toEqual({ artifact_unavailable: 3, awaiting_upload: 20 })
    expect(status.pending_receipts).toHaveLength(20)
    expect(status.pending_receipts_remaining).toBe(3)
    expect(status.pending_receipts[0]).toEqual({
      artifact_short_id: "pending0",
      artifact_version: 2,
      action: "read",
      client: "codex",
      occurred_at: "2026-09-08T01:00:00.000Z",
      reason: "artifact_unavailable",
    })
    expect(status.pending_receipts[3].reason).toBe("awaiting_upload")
    expect(result.stdout).not.toContain("private-")
    const plain = await run(project, "http://127.0.0.1:1", ["scan", "status"], {
      HOME: join(project, "home"),
    })
    expect(plain.status).toBe(0)
    expect(plain.stdout).toContain("pending0 v2")
    expect(plain.stdout).toContain("3 more pending artifact receipts")
    expect(plain.stdout).toContain("Retry with an account that can access them")
    expect(plain.stdout).not.toContain("private-")
    const all = await run(project, "http://127.0.0.1:1", ["scan", "status", "--all", "--json"], {
      HOME: join(project, "home"),
    })
    expect(all.status).toBe(0)
    expect(JSON.parse(all.stdout).artifacts.pending_receipts).toHaveLength(23)
    expect(JSON.parse(all.stdout).artifacts.pending_receipts_remaining).toBe(0)
    expect(readFileSync(spool, "utf8")).toBe(contents)
    expect(existsSync(join(config, "artifact-scan.json"))).toBe(false)
  })

  it.each([
    ["skill", "status"],
    ["skill", "--dry-run"],
    ["generic", "status"],
    ["generic", "--dry-run"],
  ])("keeps %s scan %s read-only with legacy project pins", async (scope, mode) => {
    const project = mkdtempSync(join(tmpdir(), "derive-scan-readonly-"))
    dirs.push(project)
    const home = join(project, "home")
    const skill = join(project, ".agents", "skills", "review-skill")
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, "SKILL.md"), "Review the change.")
    writeFileSync(
      join(project, "derive.json"),
      JSON.stringify({
        skills: [
          {
            id: "review123",
            version: 4,
            name: "review-skill",
            installs: { codex: { version: 4, name: "review-skill" } },
          },
        ],
      }),
    )
    const logs = join(home, ".codex", "sessions")
    mkdirSync(logs, { recursive: true })
    writeFileSync(
      join(logs, "session.jsonl"),
      `${JSON.stringify({
        type: "response_item",
        timestamp: new Date().toISOString(),
        payload: {
          type: "function_call",
          call_id: "read-skill",
          arguments: JSON.stringify({ cmd: `cat ${join(skill, "SKILL.md")}` }),
        },
      })}\n`,
    )
    const result = await run(
      project,
      "http://127.0.0.1:1",
      [...(scope === "skill" ? ["skill"] : []), "scan", mode, "--json", "--since", "30d"],
      {
        HOME: home,
      },
    )
    expect(result.status).toBe(0)
    expect(existsSync(join(project, ".derive-test-config"))).toBe(false)
    if (mode === "--dry-run") {
      const events = JSON.parse(result.stdout)[scope === "skill" ? "events" : "skills"]
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ skill_short_id: "review123" })
    }
  })

  it.each([
    ["artifact", ["scan", "setup", "--client", "codex", "--json"]],
    ["skill", ["scan", "setup", "--client", "codex", "--json"]],
    ["skill", ["skill", "scan", "--json"]],
    ["skill", ["skill", "add", "review123", "--json"]],
    ["skill", ["skill", "sync", "review123", "--json"]],
    ["skill", ["skill", "remove", "review123", "--json"]],
    ["skill", ["skill", "scan", "setup", "--client", "codex", "--json"]],
  ])("protects the %s queue from overlapping commands: %j", async (kind, args) => {
    const project = mkdtempSync(join(tmpdir(), "derive-scan-overlap-"))
    dirs.push(project)
    const config = join(project, ".derive-test-config")
    const priorConfig = process.env.DERIVE_CONFIG_DIR
    process.env.DERIVE_CONFIG_DIR = config
    let release
    try {
      release = await lockScan(kind)
      const result = await run(project, "http://127.0.0.1:1", args, { HOME: join(project, "home") })
      expect(result.status).toBe(75)
      expect(JSON.parse(result.stdout).code).toBe("scan_in_progress")
      expect(existsSync(join(config, "artifact-scan.json"))).toBe(false)
      expect(existsSync(join(config, "skill-scan.json"))).toBe(false)
      if (kind === "skill") expect(existsSync(join(config, "artifact-scan.lock"))).toBe(false)
    } finally {
      await release?.()
      if (priorConfig === undefined) delete process.env.DERIVE_CONFIG_DIR
      else process.env.DERIVE_CONFIG_DIR = priorConfig
    }
  })

  it("recovers an expired lock after the owning process is killed", async () => {
    const project = mkdtempSync(join(tmpdir(), "derive-scan-crash-"))
    dirs.push(project)
    const config = join(project, ".derive-test-config")
    const moduleUrl = pathToFileURL(join(import.meta.dirname, "..", "src", "scan-lock.js")).href
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { lockScan } from ${JSON.stringify(moduleUrl)}; await lockScan("artifact"); process.stdout.write("ready"); setInterval(() => {}, 1000);`,
      ],
      { env: { ...process.env, DERIVE_CONFIG_DIR: config } },
    )
    try {
      await new Promise((resolve, reject) => {
        child.stdout.once("data", resolve)
        child.once("error", reject)
        child.once("exit", () => reject(new Error("lock owner exited before ready")))
      })
      const closed = new Promise((resolve) => child.once("close", resolve))
      child.kill("SIGKILL")
      await closed
      const lock = join(config, "artifact-scan.lock")
      expect(existsSync(lock)).toBe(true)
      // Advance the abandoned lock's age without waiting two minutes in the suite.
      const expired = new Date(Date.now() - 180_000)
      utimesSync(lock, expired, expired)
      const result = await run(
        project,
        "http://127.0.0.1:1",
        ["scan", "setup", "--client", "codex", "--json"],
        { HOME: join(project, "home") },
      )
      expect(result.status).toBe(0)
      expect(existsSync(lock)).toBe(false)
      expect(existsSync(join(config, "artifact-scan.json"))).toBe(true)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }
  })

  it("keeps concurrent scans out of the queue and captures later appends on retry", async () => {
    const project = mkdtempSync(join(tmpdir(), "derive-scan-concurrent-"))
    dirs.push(project)
    const home = join(project, "home")
    const logDir = join(home, ".codex", "sessions")
    mkdirSync(logDir, { recursive: true })
    const log = join(logDir, "session.jsonl")
    const receipt = (callId) =>
      [
        {
          type: "response_item",
          timestamp: new Date().toISOString(),
          payload: {
            type: "function_call",
            name: "mcp__derive__read",
            call_id: callId,
            arguments: "{}",
          },
        },
        {
          type: "response_item",
          timestamp: new Date().toISOString(),
          payload: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify({ short_id: "concurrent123", version: 2 }),
          },
        },
      ]
        .map(JSON.stringify)
        .join("\n")
    writeFileSync(log, `${receipt("first")}\n`)
    let release
    const arrived = new Promise((resolve) => {
      release = resolve
    })
    let heldResponse
    const uploaded = []
    const server = http.createServer((request, response) => {
      response.setHeader("content-type", "application/json")
      if (request.url === "/v1/workspaces") {
        response.end(JSON.stringify({ workspaces: [] }))
        return
      }
      let body = ""
      request.on("data", (chunk) => {
        body += chunk
      })
      request.on("end", () => {
        const parsed = JSON.parse(body)
        uploaded.push(...parsed.events)
        const answer = JSON.stringify({
          recorded: parsed.events.map((event) => event.event_id),
          rejected: [],
        })
        if (!heldResponse) {
          heldResponse = () => response.end(answer)
          release()
        } else response.end(answer)
      })
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    servers.push(server)
    const base = `http://127.0.0.1:${server.address().port}`
    const first = run(project, base, ["scan", "--since", "30d", "--json"], { HOME: home })
    await arrived
    try {
      const config = join(project, ".derive-test-config")
      const spoolBefore = readFileSync(join(config, "artifact-scan-spool.json"), "utf8")
      const cursorBefore = readFileSync(join(config, "artifact-scan.json"), "utf8")
      writeFileSync(log, `${receipt("second")}\n`, { flag: "a" })
      const overlap = await run(project, base, ["scan", "--json"], { HOME: home })
      expect(overlap.status).toBe(75)
      expect(JSON.parse(overlap.stdout).code).toBe("scan_in_progress")
      expect(readFileSync(join(config, "artifact-scan-spool.json"), "utf8")).toBe(spoolBefore)
      expect(readFileSync(join(config, "artifact-scan.json"), "utf8")).toBe(cursorBefore)
    } finally {
      heldResponse()
      await first
    }
    const retry = await run(project, base, ["scan", "--json"], { HOME: home })
    expect(retry.status).toBe(0)
    expect(JSON.parse(retry.stdout).artifacts).toMatchObject({ found: 1, uploaded: 1, pending: 0 })
    expect(new Set(uploaded.map((event) => event.event_id)).size).toBe(2)
  })

  it.each([
    ["mcp__other__read", { short_id: "real123", version: 2 }, false],
    ["read", { short_id: "real123", version: 2 }, false],
    ["mcp__derive__read", { short_id: "real123", version: "2garbage" }, false],
    ["mcp__derive__read", { short_id: "real123", version: 2.5 }, false],
    ["mcp__derive__read", { short_id: "real123", version: 2, error: "denied" }, false],
    ["mcp__derive__publish", { short_id: "real123", version: 2, published: false }, false],
    [
      "mcp__derive__read",
      {
        isError: true,
        content: [{ type: "text", text: "short_id: real123\nversion: 2" }],
      },
      false,
    ],
    ["mcp__derive__read", { short_id: "real123", version: "2 (current)" }, true],
  ])("requires a successful Derive receipt from %s: %j", async (name, output, accepted) => {
    const root = mkdtempSync(join(tmpdir(), "derive-result-integrity-"))
    dirs.push(root)
    const priorConfig = process.env.DERIVE_CONFIG_DIR
    process.env.DERIVE_CONFIG_DIR = join(root, "config")
    try {
      const path = join(root, "session.jsonl")
      writeFileSync(
        path,
        `${[
          {
            type: "response_item",
            payload: {
              type: "function_call",
              name,
              call_id: "receipt",
              arguments: "{}",
            },
          },
          {
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "receipt",
              output: JSON.stringify(output),
            },
          },
        ]
          .map(JSON.stringify)
          .join("\n")}\n`,
      )
      const result = await scanArtifactLogs({
        home: root,
        sources: [{ client: "codex", path }],
        initialBaseline: false,
      })
      expect(result.events).toHaveLength(accepted ? 1 : 0)
    } finally {
      if (priorConfig === undefined) delete process.env.DERIVE_CONFIG_DIR
      else process.env.DERIVE_CONFIG_DIR = priorConfig
    }
  })

  it("does not record a failed Claude tool result and consumes its pending call", async () => {
    const root = mkdtempSync(join(tmpdir(), "derive-claude-error-"))
    dirs.push(root)
    const priorConfig = process.env.DERIVE_CONFIG_DIR
    process.env.DERIVE_CONFIG_DIR = join(root, "config")
    try {
      const path = join(root, "session.jsonl")
      writeFileSync(
        path,
        `${[
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "failed-read",
                  name: "mcp__derive__read",
                  input: {},
                },
              ],
            },
          },
          {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "failed-read",
                  is_error: true,
                  content: JSON.stringify({ short_id: "real123", version: 2 }),
                },
              ],
            },
          },
        ]
          .map(JSON.stringify)
          .join("\n")}\n`,
      )
      const result = await scanArtifactLogs({
        home: root,
        sources: [{ client: "claude", path }],
        initialBaseline: false,
      })
      expect(result.events).toEqual([])
      expect(result.state.pending.claude).toEqual({})
    } finally {
      if (priorConfig === undefined) delete process.env.DERIVE_CONFIG_DIR
      else process.env.DERIVE_CONFIG_DIR = priorConfig
    }
  })

  it.each([
    "{broken",
    "null",
    JSON.stringify({ version: 2, pending: [], coverage: [] }),
    JSON.stringify({ version: 1, pending: {}, coverage: [] }),
  ])("preserves an unreadable spool and its uncommitted cursor: %s", async (contents) => {
    const project = mkdtempSync(join(tmpdir(), "derive-artifact-corrupt-spool-"))
    dirs.push(project)
    const home = join(project, "home")
    const config = join(project, ".derive-test-config")
    mkdirSync(config, { recursive: true })
    mkdirSync(join(home, ".codex", "sessions"), { recursive: true })
    writeFileSync(
      join(home, ".codex", "sessions", "session.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "recovery-session" } })}\n`,
    )
    const spool = join(config, "artifact-scan-spool.json")
    writeFileSync(spool, contents)
    const result = await run(project, "http://127.0.0.1:1", ["scan", "--json"], {
      HOME: home,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("cannot read artifact scan spool")
    expect(readFileSync(spool, "utf8")).toBe(contents)
    expect(existsSync(join(config, "artifact-scan.json"))).toBe(false)
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

  it("keeps an unavailable receipt until another server accepts it", async () => {
    const project = mkdtempSync(join(tmpdir(), "derive-generic-scan-server-retry-"))
    dirs.push(project)
    const home = join(project, "home")
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
          const ids = parsed.events.map((event) => event.event_id)
          response.writeHead(200, { "content-type": "application/json" })
          response.end(
            JSON.stringify(
              accepts
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
      uploaded: 1,
      pending: 0,
    })
  })
})

describe("scan source recovery", () => {
  it.each([
    ["artifact", scanArtifactLogs],
    ["skill", scanSkillLogs],
  ])("keeps %s cursors retryable and session context across idle scans", async (_name, scan) => {
    const root = mkdtempSync(join(tmpdir(), "derive-source-recovery-"))
    dirs.push(root)
    const priorConfig = process.env.DERIVE_CONFIG_DIR
    process.env.DERIVE_CONFIG_DIR = join(root, "config")
    try {
      const healthy = join(root, "healthy.jsonl")
      const broken = join(root, "broken.jsonl")
      const header = (id) => `${JSON.stringify({ type: "session_meta", payload: { id } })}\n`
      writeFileSync(healthy, header("original-session"))
      writeFileSync(broken, header("repair-session"))
      const sources = [healthy, broken].map((path) => ({ client: "codex", path }))
      const options = { sources, home: root, initialBaseline: false }
      const initial = await scan(options)
      const saved = initial.state.sources[broken]
      const idle = await scan(options)
      expect(idle.state.sources[healthy].session).toBe("original-session")
      rmSync(broken)
      mkdirSync(broken)
      writeFileSync(
        healthy,
        `${header("original-session")}${JSON.stringify({ type: "turn_context", payload: { turn_id: "next-turn" } })}\n`,
      )
      const partial = await scan(options)
      expect(partial.source_errors).toEqual([{ client: "codex", path: broken, code: "EISDIR" }])
      expect(partial.state.sources[broken]).toEqual(saved)
      expect(partial.state.sources[healthy].offset).toBeGreaterThan(
        initial.state.sources[healthy].offset,
      )
      expect(partial.state.sources[healthy].session).toBe("original-session")
      rmSync(broken, { recursive: true })
      writeFileSync(broken, header("repaired-session"))
      const repaired = await scan(options)
      expect(repaired.source_errors).toEqual([])
      expect(repaired.state.sources[broken].session).toBe("repaired-session")
      const before = readFileSync(join(root, "config", `${_name}-scan.json`), "utf8")
      const missing = { client: "codex", path: join(root, "missing.jsonl") }
      const dry = await scan({ ...options, sources: [missing], dryRun: true })
      expect(dry.source_errors).toEqual([{ ...missing, code: "ENOENT" }])
      expect(readFileSync(join(root, "config", `${_name}-scan.json`), "utf8")).toBe(before)
    } finally {
      if (priorConfig === undefined) delete process.env.DERIVE_CONFIG_DIR
      else process.env.DERIVE_CONFIG_DIR = priorConfig
    }
  })
})

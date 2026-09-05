import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const dirs = []
const servers = []

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const run = (cwd, server, args) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, "..", "bin", "derive.js"), ...args, "--server", server],
      { cwd, env: { ...process.env, DERIVE_TOKEN: "test-token" } },
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

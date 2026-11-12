import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { stoppedBeforeReport } from "../src/lib/job-machine"
import { ARMED, OrtamClient, ortamId } from "../src/lib/ortam-client"
import { redactedOutputTail } from "../src/lib/runtime-diagnostics"
import { runtimeSetup } from "../src/lib/runtime-setup"
import {
  SandboxCreateRejected,
  SandboxRateLimited,
  SandboxRefused,
} from "../src/lib/sandbox-client"

const SBX = "01890a5d-ac96-774b-bcce-b302099a8057"
const EXE = "11111111-1111-4111-8111-111111111111"
const OP = "22222222-2222-4222-8222-222222222222"
const identity = { organization_id: "ortam.test", user_id: "key-any" }

type Body = { argv: string[]; cwd?: string; [field: string]: unknown }

/** Ortam's API as the adapter uses it: one sandbox, one execution, one operation. */
const ortam = (
  over: {
    phase?: string
    execution?: Record<string, unknown>
    operation?: Record<string, unknown>
    ssh?: Array<{ user_id: string; public_keys: string[] }>
    respond?: (request: Request, path: string) => Response | undefined
  } = {},
) => {
  const requests: Array<{ method: string; path: string; key: string | null; body: Body }> = []
  const operation = (kind: string, resource: string) => ({
    id: OP,
    kind,
    resource_id: resource,
    state: "completed",
    ...over.operation,
  })
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const path = url.pathname.replace(/^\/v1/, "") + url.search
    requests.push({
      method: request.method,
      path,
      key: request.headers.get("Idempotency-Key"),
      body: request.method === "GET" ? null : await request.json().catch(() => null),
    })
    expect(request.redirect).toBe("manual")
    if (url.host === "get.ortam.dev")
      return Response.json({
        api_url: "https://api.ortam.dev",
        ssh_host: "ssh.ortam.test",
        ssh_port: 2222,
        ssh_host_key: "ssh-ed25519 AAAAhost",
      })
    expect(request.headers.get("Authorization")).toBe("Bearer key")
    if (request.method !== "GET") expect(request.headers.get("Idempotency-Key")).toBeTruthy()
    const custom = over.respond?.(request, path)
    if (custom) return custom
    const sandbox = { id: SBX, phase: over.phase ?? "stopped" }
    if (path === "/sandboxes?limit=1") return Response.json([])
    if (path === "/sandboxes")
      return Response.json(
        { operation: operation("create", SBX), resource: sandbox },
        { status: 201 },
      )
    if (path === `/sandboxes/${SBX}` && request.method === "GET") return Response.json(sandbox)
    if (path === `/sandboxes/${SBX}` && request.method === "DELETE")
      return Response.json({ operation: operation("delete", SBX) }, { status: 202 })
    if (path === `/sandboxes/${SBX}/stop`)
      return Response.json({ operation: operation("stop", SBX) }, { status: 202 })
    if (path === `/sandboxes/${SBX}/executions`)
      return Response.json(
        { operation: operation("execute", EXE), resource: { id: EXE } },
        { status: 202 },
      )
    if (path === `/sandboxes/${SBX}/ssh-access`)
      return request.method === "GET"
        ? Response.json(over.ssh ?? [])
        : Response.json({ operation: operation("ssh_access", SBX) })
    if (path === `/operations/${OP}`)
      return Response.json(
        operation(over.operation?.kind ? String(over.operation.kind) : "execute", EXE),
      )
    if (path === `/executions/${EXE}`)
      return Response.json({
        id: EXE,
        sandbox_id: SBX,
        state: "exited",
        exit_code: 0,
        ...over.execution,
      })
    if (path === `/executions/${EXE}/output`)
      return Response.json({ stdout: { durable_end: 10 }, stderr: { durable_end: 5000 } })
    if (path.startsWith(`/executions/${EXE}/output/`)) return new Response(`tail of ${path}`)
    return Response.json(
      { code: "not_found", error: "not found", retryable: false },
      { status: 404 },
    )
  }) as typeof fetch
  return { client: new OrtamClient("https://ortam.test/v1", "key", fetcher), requests }
}

describe("Ortam IDs", () => {
  it("decodes an ID saved in Ortam's old TypeID spelling to the UUID the API takes", () => {
    expect(ortamId("sbx_01h455vb4pex5vsknk084sn02q")).toBe(SBX)
    expect(ortamId("op_7zzzzzzzzzzzzzzzzzzzzzzzzz")).toBe("ffffffff-ffff-ffff-ffff-ffffffffffff")
    expect(ortamId(SBX)).toBe(SBX)
  })

  it("reads a sandbox saved under its old ID, and calls a running one ready", async () => {
    const { client, requests } = ortam({ phase: "running" })
    expect((await client.sandbox("sbx_01h455vb4pex5vsknk084sn02q", identity)).state).toBe("ready")
    expect(requests.at(-1)?.path).toBe(`/sandboxes/${SBX}`)
  })

  it.each([
    ["a record Ortam kept as deleted", SBX, { phase: "deleted" }, true],
    ["a sandbox Ortam never had", "sbx_00000000000000000000000001", {}, true],
    ["a stopped sandbox", SBX, {}, false],
  ])("counts %s as gone or not", async (_name, id, over, gone) => {
    expect(await ortam(over).client.isSandboxDeleted(id, identity)).toBe(gone)
  })
})

describe("Ortam sandboxes that are gone or lost", () => {
  it("reads a lost sandbox as stopped: no compute, and the files it last saved", async () => {
    expect((await ortam({ phase: "lost" }).client.sandbox(SBX, identity)).state).toBe("stopped")
  })

  it.each([
    [404, "not_found"],
    [409, "sandbox_deleted"],
  ])("takes a %s %s on a command as a sandbox that may be gone", async (status, code) => {
    const { client } = ortam({
      respond: (_request, path) =>
        path.endsWith("/executions") ? Response.json({ code }, { status }) : undefined,
    })
    const launch = { argv: ["true"], cwd: "/home/ortam", env: {}, timeout_seconds: 60 }
    const error = await client.launch(SBX, launch, "k", identity).catch((e) => e)
    expect(client.notFound(error)).toBe(true)
    // Any other conflict is not evidence of that.
    const busy = ortam({
      respond: (_request, path) =>
        path.endsWith("/executions")
          ? Response.json({ code: "sandbox_transitioning" }, { status: 409 })
          : undefined,
    })
    expect(
      busy.client.notFound(await busy.client.launch(SBX, launch, "k", identity).catch((e) => e)),
    ).toBe(false)
  })
})

describe("Ortam runner requests", () => {
  const create = {
    name: "coding",
    size: "small" as const,
    auto_stop_after_seconds: 2700,
    setup_script: "mkdir -p /home/ortam/work",
    env: { TOKEN: "t" },
  }

  it("proves the key with a read, and takes the key itself as the account", async () => {
    // Ortam names no organization, so another key is another account until shown otherwise.
    const { client, requests } = ortam()
    const account = await client.authenticate()
    expect(account).toEqual({
      organization_id: "ortam.test",
      user_id: expect.stringMatching(/^key-[a-f0-9]{24}$/),
    })
    expect(requests).toMatchObject([{ method: "GET", path: "/sandboxes?limit=1" }])
    const other = new OrtamClient("https://ortam.test/v1", "another", (async () =>
      Response.json([])) as unknown as typeof fetch)
    expect((await other.authenticate()).user_id).not.toBe(account.user_id)
    expect(JSON.stringify(account)).not.toContain('key"')
  })

  it("creates the sandbox, then runs setup as the create the caller waits on", async () => {
    const { client, requests } = ortam()
    const made = await client.create(
      { ...create, snapshot: "spt_01h455vb4pex5vsknk084sn02q" },
      "k",
      identity,
    )
    expect(made).toEqual({
      sandbox: {
        id: SBX,
        state: "stopped",
        current_operation_id: null,
        auto_stop_after_seconds: 0,
      },
      operation: { id: OP, sandbox_id: SBX, kind: "create", state: "queued" },
    })
    expect(requests[0]).toMatchObject({
      path: "/sandboxes",
      key: "k",
      body: { name: "coding", size: "small", snapshot_id: SBX },
    })
    // Setup runs under the armed stop timer, with the create's variables as its environment.
    expect(requests[1]).toMatchObject({
      path: `/sandboxes/${SBX}/executions`,
      key: "k-setup",
      body: { env: { TOKEN: "t" }, timeout_seconds: 2700 },
    })
    expect(requests[1]?.body.argv.slice(3)).toEqual([
      "derive",
      "2700",
      "/home/ortam",
      "sh",
      "-c",
      "mkdir -p /home/ortam/work",
    ])
    expect(requests[1]?.body.argv[2]).toBe(ARMED)
  })

  it.each([
    ["exited", 0, "succeeded"],
    ["exited", 1, "failed"],
    ["running", null, "running"],
    ["accepted", null, "queued"],
    ["timed_out", null, "failed"],
    ["infrastructure_lost", null, "failed"],
  ])("settles a create or resume by its command: %s %s is %s", async (state, exit_code, want) => {
    const { client } = ortam({ execution: { state, exit_code } })
    expect((await client.operation(OP, SBX, "create", identity)).state).toBe(want)
    expect((await client.operation(OP, SBX, "resume", identity)).state).toBe(want)
  })

  it.each([
    ["another sandbox's command", { execution: { sandbox_id: EXE } }, "create" as const],
    [
      "a stop read as a resume",
      { operation: { kind: "stop", resource_id: SBX } },
      "resume" as const,
    ],
    ["another sandbox's stop", { operation: { kind: "stop", resource_id: EXE } }, "stop" as const],
    [
      "a delete read as a stop",
      { operation: { kind: "delete", resource_id: SBX } },
      "stop" as const,
    ],
  ])("refuses %s", async (_name, over, kind) => {
    await expect(ortam(over).client.operation(OP, SBX, kind, identity)).rejects.toThrow(
      "Ortam operation mismatch",
    )
  })

  it.each([
    ["completed", "succeeded"],
    ["pending", "queued"],
    ["unknown", "failed"],
  ])("reads a %s stop as %s", async (state, want) => {
    const { client } = ortam({ operation: { kind: "stop", resource_id: SBX, state } })
    expect((await client.operation(OP, SBX, "stop", identity)).state).toBe(want)
  })

  it.each([
    ["published", "succeeded"],
    ["not_required", "succeeded"],
    ["failed", "failed"],
    ["unknown", "failed"],
  ])("counts a completed stop whose final save is %s as %s", async (save, want) => {
    // A stopped sandbox promises its files were saved.
    const { client } = ortam({
      operation: { kind: "stop", resource_id: SBX, result: { final_save: { state: save } } },
    })
    expect((await client.operation(OP, SBX, "stop", identity)).state).toBe(want)
    expect((await client.lifecycle(SBX, "stop", "k", identity)).state).toBe(want)
  })

  it.each([
    ["organization_machine_limit_reached", SandboxRateLimited, "all its machines in use"],
    ["organization_not_approved", SandboxRefused, "waiting for approval"],
    ["organization_storage_limit_reached", SandboxRefused, "out of storage"],
  ])("says %s as a wait or a refusal, in words", async (code, kind, words) => {
    const { client } = ortam({
      respond: (request) =>
        request.method === "POST" ? Response.json({ code }, { status: 403 }) : undefined,
    })
    const error = await client.lifecycle(SBX, "resume", "k", identity).catch((e) => e)
    expect(error).toBeInstanceOf(kind)
    expect(error.message).toContain(words)
  })

  it("names the sandbox it made when setup could not be sent, so a caller can delete it", async () => {
    const { client } = ortam({
      respond: (_request, path) =>
        path.endsWith("/executions") ? new Response(null, { status: 503 }) : undefined,
    })
    const error = await client.create(create, "k", identity).catch((e) => e)
    expect(error.sandbox_id).toBe(SBX)
  })

  it.each([
    ["a Boat environment", { environment: "prod" }, "Ortam does not support Boat environments"],
    ["a snapshot name", { snapshot: "base" }, "Ortam snapshots need a snapshot ID"],
  ])("rejects %s before allocation", async (_name, extra, message) => {
    const { client, requests } = ortam()
    await expect(client.create({ ...create, ...extra }, "k", identity)).rejects.toThrow(message)
    expect(requests).toEqual([])
  })

  it.each([
    ["small", "small"],
    ["default", undefined],
    ["large", undefined],
    ["xlarge", undefined],
  ] as const)("asks for a %s machine as Ortam's %s, medium being its default and largest", async (size, sent) => {
    const { client, requests } = ortam()
    await client.create({ ...create, size }, "k", identity)
    expect(requests[0]?.body.size).toBe(sent)
  })

  it("keeps a create whose setup was rate limited as unknown, not as never allocated", async () => {
    const { client } = ortam({
      respond: (_request, path) =>
        path.endsWith("/executions")
          ? new Response("{}", { status: 429, headers: { "Retry-After": "5" } })
          : undefined,
    })
    const error = await client.create(create, "k", identity).catch((e) => e)
    expect(error).not.toBeInstanceOf(SandboxRateLimited)
    expect(error.message).toBe("Ortam request outcome is unknown")
  })

  it.each([
    400, 404, 422,
  ])("reads a %s on create as a refusal, not an unknown outcome", async (status) => {
    const { client } = ortam({
      respond: (_request, path) =>
        path === "/sandboxes"
          ? Response.json({ code: "invalid_request", error: "secret prose" }, { status })
          : undefined,
    })
    const error = await client.create(create, "k", identity).catch((e) => e)
    expect(error).toBeInstanceOf(SandboxCreateRejected)
    expect(error.message).toBe(`Ortam returned HTTP ${status} (invalid_request)`)
  })

  it("waits out a rate limit for as long as Ortam says", async () => {
    const { client } = ortam({
      respond: () => new Response("{}", { status: 429, headers: { "Retry-After": "17" } }),
    })
    const error = await client.lifecycle(SBX, "resume", "k", identity).catch((e) => e)
    expect(error).toBeInstanceOf(SandboxRateLimited)
    expect(error.retryAfterSeconds).toBe(17)
  })

  it("resumes with a command, so the start and its stop timer are one request", async () => {
    const { client, requests } = ortam()
    const op = await client.lifecycle(SBX, "resume", "k", identity, {}, { ttl_seconds: 4200 })
    expect(op).toEqual({ id: OP, sandbox_id: SBX, kind: "resume", state: "queued" })
    expect(requests.at(-1)).toMatchObject({ path: `/sandboxes/${SBX}/executions`, key: "k" })
    expect(requests.at(-1)?.body.argv.slice(3)).toEqual(["derive", "4200", "/home/ortam", "true"])
    await expect(
      client.lifecycle(SBX, "resume", "k", identity, {}, { environment: "prod" }),
    ).rejects.toThrow("Ortam does not support Boat environments")
  })

  it("launches the runner in its directory, armed past its own timeout", async () => {
    const { client, requests } = ortam()
    const process = await client.launch(
      SBX,
      { argv: ["node", "runner.js"], cwd: "/home/ortam", env: { A: "b" }, timeout_seconds: 900 },
      "k",
      identity,
    )
    expect(process).toEqual({ id: EXE, status: "starting" })
    // Ortam refuses a working directory that does not exist yet, so the command enters it.
    expect(requests[0]?.body).toMatchObject({ env: { A: "b" }, timeout_seconds: 900 })
    expect(requests[0]?.body.cwd).toBeUndefined()
    expect(requests[0]?.body.argv.slice(3)).toEqual([
      "derive",
      "1500",
      "/home/ortam",
      "node",
      "runner.js",
    ])
  })

  it.each([
    "stop",
    "resume",
  ] as const)("takes back the SSH keys Derive listed before a %s", async (action) => {
    // An SSH login starts a stopped sandbox with nothing to stop it again.
    const { client, requests } = ortam({
      ssh: [
        { user_id: "derive-abc", public_keys: ["ssh-ed25519 AAAAone"] },
        { user_id: "derive-already-empty", public_keys: [] },
        { user_id: "someone-else", public_keys: ["ssh-ed25519 AAAAtwo"] },
      ],
    })
    await client.lifecycle(SBX, action, "k", identity)
    expect(requests.map((request) => [request.method, request.path, request.body])).toEqual([
      ["GET", `/sandboxes/${SBX}/ssh-access`, null],
      ["POST", `/sandboxes/${SBX}/ssh-access`, { user_id: "derive-abc", public_keys: [] }],
      action === "stop"
        ? ["POST", `/sandboxes/${SBX}/stop`, null]
        : ["POST", `/sandboxes/${SBX}/executions`, expect.anything()],
    ])
  })

  it("stops and deletes by the sandbox's own operation", async () => {
    const stop = ortam({ operation: { state: "pending" } })
    expect(await stop.client.lifecycle(SBX, "stop", "k", identity)).toEqual({
      id: OP,
      sandbox_id: SBX,
      kind: "stop",
      state: "queued",
    })
    const gone = ortam()
    expect((await gone.client.deleteSandbox(SBX, "k", identity)).kind).toBe("delete")
    expect(gone.requests[0]).toMatchObject({
      method: "DELETE",
      path: `/sandboxes/${SBX}`,
      key: "k",
    })
  })
})

describe("Ortam runtime installation", () => {
  it("installs exact harness versions without a root npm prefix and exposes them to the runner", () => {
    const directory = mkdtempSync(join(tmpdir(), "derive-ortam-runtime-"))
    const bin = join(directory, "bin")
    mkdirSync(bin)
    const npm = join(bin, "npm")
    writeFileSync(
      npm,
      `#!/bin/sh
set -eu
prefix=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) shift; prefix=$1 ;;
    @derive-to/cli@*) package=runner ;;
    @openai/codex@0.162.1) package=codex ;;
    @anthropic-ai/claude-code@2.1.309) package=claude ;;
  esac
  shift
done
test -n "$prefix" || { printf 'root npm prefix refused\n' >&2; exit 1; }
case "$package" in
  runner) mkdir -p "$prefix/node_modules/@derive-to/cli/bin"; printf '' > "$prefix/node_modules/@derive-to/cli/bin/derive.js" ;;
  codex) mkdir -p "$prefix/bin"; printf '#!/bin/sh\nprintf "codex-cli 0.162.1\\n"\n' > "$prefix/bin/codex"; chmod 755 "$prefix/bin/codex" ;;
  claude) mkdir -p "$prefix/bin"; printf '#!/bin/sh\nprintf "2.1.309 (Claude Code)\\n"\n' > "$prefix/bin/claude"; chmod 755 "$prefix/bin/claude" ;;
esac
`,
    )
    chmodSync(npm, 0o755)
    for (const [command, output] of [
      ["codex", "old codex"],
      ["claude", "old claude"],
      ["tmux", ""],
    ] as const) {
      const path = join(bin, command)
      writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`)
      chmodSync(path, 0o755)
    }
    try {
      const result = spawnSync(
        "sh",
        [
          "-c",
          `${runtimeSetup().replaceAll("/home/ortam", directory)}\ncodex --version\nclaude --version`,
        ],
        {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
          encoding: "utf8",
          timeout: 5000,
        },
      )
      expect({ status: result.status, stderr: result.stderr, stdout: result.stdout }).toEqual({
        status: 0,
        stderr: "",
        stdout: "codex-cli 0.162.1\n2.1.309 (Claude Code)\n",
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("Ortam SSH access", () => {
  const publicKey = "ssh-ed25519 AAAAclient"

  it("lists the key on the sandbox and points the client at Ortam's gateway", async () => {
    const { client, requests } = ortam()
    expect(await client.sshKey(SBX, publicKey, identity)).toEqual({
      transport: "direct",
      host: "ssh.ortam.test",
      port: 2222,
      user: SBX,
      host_key: "ssh-ed25519 AAAAhost",
    })
    const granted = requests.find((request) => request.path === `/sandboxes/${SBX}/ssh-access`)
    // One entry per key: Ortam replaces an entry's keys and ends its sessions.
    expect(granted?.body).toEqual({
      user_id: expect.stringMatching(/^derive-[a-f0-9]{32}$/),
      public_keys: [publicKey],
    })
    expect((await ortam().client.sshKey(SBX, "ssh-ed25519 AAAAother", identity)).user).toBe(SBX)
  })

  it("gives no access when the sandbox is not this key's", async () => {
    const { client } = ortam({
      respond: (_request, path) =>
        path.endsWith("/ssh-access")
          ? Response.json({ code: "not_found" }, { status: 404 })
          : undefined,
    })
    await expect(client.sshKey(SBX, publicKey, identity)).rejects.toThrow(
      "Ortam returned HTTP 404 (not_found)",
    )
  })
})

describe("Ortam process reads", () => {
  it.each([
    ["accepted", "starting"],
    ["running", "running"],
  ])("reads a command still %s without touching its output", async (state, status) => {
    const { client, requests } = ortam({ execution: { state, exit_code: null } })
    expect(await client.process(SBX, EXE, identity, 4096)).toEqual({ id: EXE, status })
    expect(requests).toHaveLength(1)
  })

  it("reads status only by default", async () => {
    const { client, requests } = ortam({ execution: { exit_code: 7 } })
    expect(await client.process(SBX, EXE, identity)).toEqual({
      id: EXE,
      status: "exited",
      exit_code: 7,
    })
    expect(requests).toHaveLength(1)
  })

  it("reads a bounded output tail when asked, and keeps how the process ended", async () => {
    const { client } = ortam({ execution: { state: "resource_exhausted", exit_code: null } })
    expect(await client.process(SBX, EXE, identity, 4096)).toEqual({
      id: EXE,
      status: "failed",
      reason: "resource_exhausted",
      stdout: `tail of /executions/${EXE}/output/stdout?offset=0&limit=4096`,
      stderr: `tail of /executions/${EXE}/output/stderr?offset=904&limit=4096`,
    })
  })

  it("reads a process saved under its old ID as an unknown command, not a malformed one", async () => {
    const { client, requests } = ortam()
    const error = await client
      .process(SBX, "prc_01h455vb4pex5vsknk084sn02q", identity)
      .catch((e) => e)
    expect(requests[0]?.path).toBe(`/executions/${SBX}`)
    expect(client.notFound(error)).toBe(true)
  })

  it("refuses another sandbox's command", async () => {
    await expect(ortam().client.process(EXE, EXE, identity)).rejects.toThrow(
      "Ortam process mismatch",
    )
  })
})

describe("Ortam usage", () => {
  const usage = (pages: Record<string, unknown>) =>
    ortam({
      respond: (_request, path) => {
        const page = pages[path.replace(`/sandboxes/${SBX}/usage`, "")]
        return page
          ? Response.json({ as_of: "2026-11-12T01:00:00Z", atoms_per_unit: 1e9, compute: page })
          : undefined
      },
    }).client.usage(SBX, "2026-11-12T00:05:00Z", "2026-11-12T02:00:00Z", identity)

  it("charges a turn its share of each start it ran in, across every page", async () => {
    expect(
      await usage({
        "": {
          next_after: 7,
          // Ten minutes, half of them inside the window.
          starts: [
            {
              running_at: "2026-11-12T00:00:00Z",
              ended_at: "2026-11-12T00:10:00Z",
              charge_atoms: "4000000",
            },
          ],
        },
        "?after=7": {
          next_after: null,
          starts: [
            // Still running: charged to date, all of it inside.
            { running_at: "2026-11-12T00:20:00Z", ended_at: null, charge_atoms: "1000000" },
            // Never ran, and one outside the window that Ortam could not price.
            { running_at: null, ended_at: null, charge_atoms: null },
            {
              running_at: "2026-11-11T00:00:00Z",
              ended_at: "2026-11-11T00:10:00Z",
              charge_atoms: null,
              gap: "unpriced",
            },
          ],
        },
      }),
    ).toEqual({ billable_seconds: 300 + 2400, cost_micro_usd: 2000 + 1000 })
  })

  it.each([
    ["could not price", { charge_atoms: null, gap: "unpriced" }],
    ["has not charged yet", { charge_atoms: null }],
  ])("gives no cost at all, never a low one, for a start in the window it %s", async (_name, start) => {
    const starts = [
      { running_at: "2026-11-12T00:10:00Z", ended_at: "2026-11-12T00:20:00Z", ...start },
    ]
    await expect(usage({ "": { starts } })).rejects.toThrow("Ortam usage is not settled")
  })
})

describe("the stop timer a command arms", () => {
  // The script that bounds what a forgotten machine costs, run for real with the machine's
  // root commands replaced by a recorder.
  const arm = (systemctl: string) => {
    const dir = mkdtempSync(join(tmpdir(), "derive-armed-"))
    const bin = join(dir, "bin")
    mkdirSync(bin)
    writeFileSync(
      join(bin, "sudo"),
      `#!/bin/sh\necho "sudo $*" >> "${dir}/log"\ncase "$1" in tee) cat > "${dir}/$(basename "$2")" ;; systemctl) ${systemctl} ;; esac\n`,
    )
    chmodSync(join(bin, "sudo"), 0o755)
    // Asked without sudo whether the service is installed: not yet, on a new disk.
    writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n")
    chmodSync(join(bin, "systemctl"), 0o755)
    const ran = spawnSync(
      "sh",
      ["-c", ARMED, "derive", "900", dir, "sh", "-c", 'echo "ran in $(pwd) with $1"', "x", "arg"],
      { env: { PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" },
    )
    const read = (name: string) => readFileSync(join(dir, name), "utf8")
    const result = { status: ran.status, stdout: ran.stdout, log: read("log"), read }
    return { ...result, clean: () => rmSync(dir, { recursive: true, force: true }) }
  }

  it("installs the power-off service, sets the deadline, then runs the command in its directory", () => {
    const armed = arm("true")
    try {
      expect(armed.status).toBe(0)
      expect(armed.stdout).toMatch(/^ran in .*derive-armed-.* with arg\n$/)
      const calls = armed.log.split("\n")
      const deadline = Number(armed.read("derive-stop-at.new"))
      expect(Math.abs(deadline - (Date.now() / 1000 + 900))).toBeLessThan(30)
      // The service powers off at the deadline, and fifteen minutes after a boot that set none.
      expect(armed.read("derive-stop-1")).toContain("|| poweroff")
      expect(armed.read("derive-stop-1")).toContain("+ 900")
      // Enabling comes last, and is what a later command checks before trusting the install.
      expect(calls.at(-2)).not.toBe("sudo systemctl enable derive-stop.service")
      expect(calls.indexOf("sudo chmod 755 /usr/local/sbin/derive-stop-1")).toBeLessThan(
        calls.indexOf("sudo systemctl enable derive-stop.service"),
      )
      expect(ARMED).toContain("systemctl is-enabled --quiet derive-stop.service")
      expect(armed.read("derive-stop.service")).toContain("WantedBy=multi-user.target")
      expect(calls).toContain("sudo systemctl enable derive-stop.service")
      expect(calls.indexOf("sudo mv /run/derive-stop-at.new /run/derive-stop-at")).toBeLessThan(
        calls.indexOf("sudo systemctl start derive-stop.service"),
      )
    } finally {
      armed.clean()
    }
  })

  it("does not run the command when the service will not start", () => {
    const armed = arm('[ "$2" != start ]')
    try {
      expect(armed.status).not.toBe(0)
      expect(armed.stdout).toBe("")
    } finally {
      armed.clean()
    }
  })
})

describe("runner output in a failure", () => {
  it("drops control sequences, joins lines and keeps the end", () => {
    const tail = redactedOutputTail("\u001b[31mnpm ERR!\u001b[0m code E404\r\n\n  not found\n")
    expect(tail).toBe("npm ERR! code E404 | not found")
    const long = redactedOutputTail(`${"a ".repeat(300)}END`, 40)
    expect(long?.length).toBe(40)
    expect(long?.startsWith("\u2026")).toBe(true)
    expect(long?.endsWith("END")).toBe(true)
    expect(redactedOutputTail("")).toBeNull()
    expect(redactedOutputTail("\n \n")).toBeNull()
    expect(redactedOutputTail(undefined)).toBeNull()
  })

  it.each([
    ["postgres://user:hunter2@db.example.com/app", "postgres://[redacted]@db.example.com/app"],
    ["DERIVE_TOKEN=dkjob_abcdefghijklmnop", "DERIVE_TOKEN=[redacted]"],
    ["api_key: abc12345", "api_key: [redacted]"],
    ["authorization: Bearer abcdefghijklmnop", "authorization: [redacted]"],
    ["token dk_agt_7351fe7f6b6d4f4a93 refused", "token [redacted] refused"],
    ["ANTHROPIC key sk-ant-api03-abcdefgh", "ANTHROPIC key [redacted]"],
    ["remote: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12 rejected", "remote: [redacted] rejected"],
    ["github_pat_11ABCDEFG0123456789_abc", "[redacted]"],
    // Assembled so no token-shaped literal sits in the source for a secret scan to flag.
    [
      `jwt ${["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"].join(".")}`,
      "jwt [redacted]",
    ],
    [`sha ${"ab".repeat(32)} mismatch`, "sha [redacted] mismatch"],
    [`blob ${"Qm".repeat(24)}== here`, "blob [redacted] here"],
    ["npm ERR! code ENOTFOUND registry.npmjs.org", "npm ERR! code ENOTFOUND registry.npmjs.org"],
  ])("redacts %s", (input, expected) => {
    expect(redactedOutputTail(input)).toBe(expected)
  })

  it("says how the runner ended when it never reported", () => {
    expect(stoppedBeforeReport()).toBe("The machine stopped before the job reported back.")
    expect(stoppedBeforeReport({ status: "exited", code: 1, tail: "test failed" })).toBe(
      "The machine stopped before the job reported back. The runner exited with code 1. Last output: test failed",
    )
    expect(stoppedBeforeReport({ status: "exited" })).toBe(
      "The machine stopped before the job reported back. The runner exited with code unknown.",
    )
    expect(
      stoppedBeforeReport({ status: "failed", reason: "out_of_memory", signal: "SIGKILL" }),
    ).toBe(
      "The machine stopped before the job reported back. The runner process failed (out_of_memory), SIGKILL.",
    )
    expect(stoppedBeforeReport({ status: "deadline" })).toMatch(/run budget/)
    expect(
      stoppedBeforeReport({ status: "not_ready", reason: "state starting, stop timer 0s" }),
    ).toBe(
      "The machine came back from the provider in a shape Derive will not launch on (state starting, stop timer 0s), so it was stopped before the runner started.",
    )
  })
})

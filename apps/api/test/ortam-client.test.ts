import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { OrtamClient, ortamId } from "../src/lib/ortam-client"
import { runtimeSetup } from "../src/lib/runtime-setup"
import { SandboxCreateRejected } from "../src/lib/sandbox-client"

describe("Ortam IDs", () => {
  it("re-encodes a bare UUID as Ortam's public ID, per the TypeID spec", () => {
    expect(ortamId("sbx", "01890a5d-ac96-774b-bcce-b302099a8057")).toBe(
      "sbx_01h455vb4pex5vsknk084sn02q",
    )
    expect(ortamId("sbx", "00000000-0000-0000-0000-000000000000")).toBe(
      "sbx_00000000000000000000000000",
    )
    expect(ortamId("op", "ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(
      "op_7zzzzzzzzzzzzzzzzzzzzzzzzz",
    )
    expect(ortamId("sbx", "sbx_325h5hmfmy8m4t5ynfdyfzfv2d")).toBe("sbx_325h5hmfmy8m4t5ynfdyfzfv2d")
  })

  it("reaches a sandbox saved under its old UUID by its public ID", async () => {
    const identity = { organization_id: "org", user_id: "usr" }
    const paths: string[] = []
    const fetcher = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      if (path === "/v1/integration") return Response.json(identity)
      return Response.json({
        id: "sbx_01h455vb4pex5vsknk084sn02q",
        state: "stopped",
        current_operation_id: null,
        auto_stop_after_seconds: 1200,
      })
    }) as typeof fetch
    const client = new OrtamClient("https://ortam.test/v1", "key", "subject", fetcher)
    const sandbox = await client.sandbox("01890a5d-ac96-774b-bcce-b302099a8057", identity)
    expect(sandbox.state).toBe("stopped")
    expect(paths).toContain("/v1/sandboxes/sbx_01h455vb4pex5vsknk084sn02q")
  })
})

describe("Ortam runner requests", () => {
  const identity = { organization_id: "org", user_id: "usr" }
  const create = {
    name: "coding",
    size: "small" as const,
    auto_stop_after_seconds: 2700,
    setup_script: "mkdir -p /home/ortam/work",
  }
  const requests: Request[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    requests.push(request)
    if (new URL(request.url).pathname === "/v1/integration") return Response.json(identity)
    if (new URL(request.url).pathname.endsWith("/processes"))
      return Response.json({ id: "proc", status: "running" })
    return Response.json({
      sandbox: {
        id: "sbx",
        state: "creating",
        current_operation_id: "op",
        auto_stop_after_seconds: 2700,
      },
      operation: { id: "op", sandbox_id: "sbx", kind: "create", state: "queued" },
    })
  }) as typeof fetch

  it.each([
    ["spt_01h455vb4pex5vsknk084sn02q", "spt_01h455vb4pex5vsknk084sn02q"],
    ["01890a5d-ac96-774b-bcce-b302099a8057", "spt_01h455vb4pex5vsknk084sn02q"],
  ])("creates from snapshot %s and retains the setup script", async (snapshot, snapshotId) => {
    requests.length = 0
    const client = new OrtamClient("https://ortam.test/v1", "key", "subject", fetcher)
    const result = await client.create({ ...create, snapshot }, "create-turn", identity)
    expect(result.operation.state).toBe("queued")
    const request = requests.at(-1)
    expect(await request?.json()).toEqual({ ...create, source: { snapshot_id: snapshotId } })
    expect(request?.headers.get("Authorization")).toBe("Bearer key")
    expect(request?.headers.get("X-Ortam-Integration-Subject")).toBe("subject")
    expect(request?.headers.get("Idempotency-Key")).toBe("create-turn")
  })

  it.each([
    [{ ...create, snapshot: "team-template" }, "Ortam snapshots need a snapshot ID"],
    [{ ...create, environment: "boat-environment" }, "Ortam does not support Boat environments"],
  ])("rejects unsupported creation settings instead of dropping them", async (body, message) => {
    const client = new OrtamClient("https://ortam.test/v1", "key", "subject", fetcher)
    await expect(client.create(body, "create-turn", identity)).rejects.toThrow(message)
  })

  it.each([
    undefined,
    "default" as const,
  ])("omits provider size when the requested size is %s", async (size) => {
    requests.length = 0
    const client = new OrtamClient("https://ortam.test/v1", "key", "subject", fetcher)
    await client.create({ ...create, size }, "create-turn", identity)
    expect(await requests.at(-1)?.json()).not.toHaveProperty("size")
  })

  it("rejects unsupported Ortam sizes before allocation", async () => {
    requests.length = 0
    const client = new OrtamClient("https://ortam.test/v1", "key", "subject", fetcher)
    await expect(
      client.create({ ...create, size: "xlarge" }, "create-turn", identity),
    ).rejects.toBeInstanceOf(SandboxCreateRejected)
    expect(requests).toHaveLength(0)
  })

  it.each([
    400, 404, 422, 409, 500,
  ])("classifies create HTTP %s without treating an unknown allocation as rejected", async (status) => {
    const client = new OrtamClient("https://ortam.test/v1", "key", "subject", async (input) =>
      new URL(String(input)).pathname === "/v1/integration"
        ? Response.json(identity)
        : new Response(null, { status }),
    )
    const refusal = client.create(create, "create-turn", identity)
    if ([400, 404, 422].includes(status))
      await expect(refusal).rejects.toBeInstanceOf(SandboxCreateRejected)
    else await expect(refusal).rejects.not.toBeInstanceOf(SandboxCreateRejected)
    await expect(client.sandbox("sbx", identity)).rejects.not.toBeInstanceOf(SandboxCreateRejected)
  })

  it("rejects a Boat environment when resuming a saved Ortam sandbox", async () => {
    const client = new OrtamClient("https://ortam.test/v1", "key", "subject", fetcher)
    await expect(
      client.lifecycle("sbx", "resume", "resume-turn", identity, undefined, {
        environment: "boat-environment",
      }),
    ).rejects.toThrow("Ortam does not support Boat environments")
  })

  it("holds the sandbox awake for a new runner while replaying legacy launches unchanged", async () => {
    const client = new OrtamClient("https://ortam.test/v1", "key", "subject", fetcher)
    const body = {
      argv: ["sh", "-c", "exec node /home/ortam/runner.js"],
      cwd: "/home/ortam",
      env: { DERIVE_SERVER: "https://derive.test" },
      timeout_seconds: 21600,
    }
    for (const keepAwake of [undefined, true, false]) {
      requests.length = 0
      const process = await client.launch(
        "sbx",
        { ...body, keep_awake: keepAwake },
        "launch-turn",
        identity,
      )
      expect(process.status).toBe("running")
      expect(await requests.at(-1)?.json()).toEqual({
        ...body,
        ...(keepAwake !== false ? { keep_awake: true } : {}),
      })
    }
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
    @anthropic-ai/claude-code@2.1.141) package=claude ;;
  esac
  shift
done
test -n "$prefix" || { printf 'root npm prefix refused\n' >&2; exit 1; }
case "$package" in
  runner) mkdir -p "$prefix/node_modules/@derive-to/cli/bin"; printf '' > "$prefix/node_modules/@derive-to/cli/bin/derive.js" ;;
  codex) mkdir -p "$prefix/bin"; printf '#!/bin/sh\nprintf "codex-cli 0.162.1\\n"\n' > "$prefix/bin/codex"; chmod 755 "$prefix/bin/codex" ;;
  claude) mkdir -p "$prefix/bin"; printf '#!/bin/sh\nprintf "2.1.141 (Claude Code)\\n"\n' > "$prefix/bin/claude"; chmod 755 "$prefix/bin/claude" ;;
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
        stdout: "codex-cli 0.162.1\n2.1.141 (Claude Code)\n",
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("managed Ortam SSH access", () => {
  const identity = { organization_id: "org", user_id: "usr" }
  const sandbox = "sbx_01h455vb4pex5vsknk084sn02q"
  it("issues a certificate for the owned key and builds the fixed authenticated tunnel request", async () => {
    const requests: Request[] = []
    const before = new Date(Date.now() + 300_000).toISOString()
    const client = new OrtamClient(
      "https://ortam.test/v1",
      "fixture-key",
      "agent-subject",
      async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        if (new URL(request.url).pathname === "/v1/integration") return Response.json(identity)
        return Response.json({
          certificate: "ssh-ed25519-cert-v01@openssh.com AAAAcert",
          principal: "ortam-integration-identity",
          valid_before: before,
          host_public_key: "ssh-ed25519 AAAAhost",
        })
      },
    )
    expect(await client.sshKey(sandbox, "ssh-ed25519 AAAAclient", identity)).toEqual({
      transport: "websocket",
      user: "ortam",
      host_key: "ssh-ed25519 AAAAhost",
      certificate: "ssh-ed25519-cert-v01@openssh.com AAAAcert",
      certificate_expires_at: before,
    })
    const issue = requests.at(-1)
    expect(issue?.url).toBe(`https://ortam.test/v1/sandboxes/${sandbox}/ssh-certificate`)
    expect(issue?.method).toBe("POST")
    expect(await issue?.json()).toEqual({ public_key: "ssh-ed25519 AAAAclient" })
    const tunnel = await client.sshTunnel("01890a5d-ac96-774b-bcce-b302099a8057", identity)
    expect(tunnel.url).toBe(`https://ortam.test/v1/sandboxes/${sandbox}/ssh-tunnel`)
    expect(tunnel.method).toBe("GET")
    expect(tunnel.headers.get("Authorization")).toBe("Bearer fixture-key")
    expect(tunnel.headers.get("X-Ortam-Integration-Subject")).toBe("agent-subject")
    expect(tunnel.redirect).toBe("manual")
    expect(tunnel.headers.get("Upgrade")).toBe("websocket")
  })

  it.each([
    "ssh-rsa",
    "ecdsa-sha2-nistp256",
  ])("returns the provider's %s certificate for that public-key algorithm", async (algorithm) => {
    const certificate = `${algorithm}-cert-v01@openssh.com AAAAcert`
    const client = new OrtamClient(
      "https://ortam.test/v1",
      "fixture-key",
      "subject",
      async (input) =>
        new URL(String(input)).pathname === "/v1/integration"
          ? Response.json(identity)
          : Response.json({
              certificate,
              principal: "identity",
              valid_before: new Date(Date.now() + 300_000).toISOString(),
              host_public_key: "ssh-ed25519 AAAAhost",
            }),
    )
    expect(await client.sshKey(sandbox, `${algorithm} AAAAclient`, identity)).toMatchObject({
      transport: "websocket",
      certificate,
    })
  })

  it("refuses changed provider ownership before opening a tunnel", async () => {
    const client = new OrtamClient("https://ortam.test/v1", "fixture-key", "subject", async () =>
      Response.json({ organization_id: "other", user_id: "usr" }),
    )
    await expect(client.sshTunnel(sandbox, identity)).rejects.toThrow("ownership changed")
  })

  it.each([
    [
      "ssh-ed25519 AAAAhost\nssh-ed25519 injected",
      "ssh-ed25519-cert-v01@openssh.com AAAAcert",
      new Date(Date.now() + 300_000).toISOString(),
    ],
    [
      "ssh-ed25519 AAAAhost",
      "ssh-ed25519-cert-v01@openssh.com AAAAcert\noption",
      new Date(Date.now() + 300_000).toISOString(),
    ],
    [
      "ssh-ed25519 AAAAhost",
      "ssh-ed25519-cert-v01@openssh.com AAAAcert",
      new Date(Date.now() - 1000).toISOString(),
    ],
  ])("refuses unsafe or expired certificate responses", async (host_public_key, certificate, valid_before) => {
    const client = new OrtamClient(
      "https://ortam.test/v1",
      "fixture-key",
      "subject",
      async (input) =>
        new URL(String(input)).pathname === "/v1/integration"
          ? Response.json(identity)
          : Response.json({ host_public_key, certificate, valid_before, principal: "identity" }),
    )
    await expect(client.sshKey(sandbox, "ssh-ed25519 AAAAclient", identity)).rejects.toThrow()
  })
})

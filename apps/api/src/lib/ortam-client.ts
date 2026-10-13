import { unbound } from "@derive/broker"
import { decodeJwt } from "jose"
import { z } from "zod"
import {
  type SandboxClient,
  type SandboxCreate,
  SandboxCreateRejected,
  type SandboxLaunch,
  type SandboxMachine,
} from "./sandbox-client"

const Sandbox = z.object({
  id: z.string(),
  state: z.string(),
  current_operation_id: z.string().nullable(),
  auto_stop_after_seconds: z.number(),
})
const Operation = z.object({
  id: z.string(),
  sandbox_id: z.string(),
  kind: z.string(),
  state: z.enum(["queued", "running", "succeeded", "failed"]),
})
const Process = z.object({
  id: z.string(),
  status: z.enum([
    "starting",
    "running",
    "exited",
    "failed",
    "timed_out",
    "stopped",
    "interrupted",
  ]),
})

// Public Ortam processes use the workspace user. Install a verified Node runtime
// on the saved writable disk only when the base image lacks Node 24+.
const PUBLIC_RUNNER_SETUP = [
  "set -eu",
  "if ! command -v npm >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) < 24 ? 1 : 0)'; then",
  "  case $(uname -m) in",
  "    x86_64) arch=x64; checksum=41cd79bb7877c81605a9e68ec4c91547774f46a40c67a17e34d7179ef11729df ;;",
  "    aarch64) arch=arm64; checksum=e7adfca03d9173276114a6f2219df1a7d25e1bfd6bbd771d3f839118a2053094 ;;",
  "    *) exit 1 ;;",
  "  esac",
  "  node_dir=/home/ortam/.derive-node/node-v24.14.0-linux-$arch",
  '  if [ ! -x "$node_dir/bin/node" ]; then',
  '    test ! -e "$node_dir"',
  "    mkdir -p /home/ortam/.derive-node",
  "    node_stage=$(mktemp -d /home/ortam/.derive-node/.install-XXXXXX)",
  "    trap 'rm -rf \"$node_stage\"' EXIT",
  '    curl -fsSL --max-time 120 "https://nodejs.org/dist/v24.14.0/node-v24.14.0-linux-$arch.tar.xz" -o "$node_stage/node.tar.xz"',
  '    printf \'%s  %s\\n\' "$checksum" "$node_stage/node.tar.xz" | sha256sum -c -',
  '    mkdir "$node_stage/runtime"',
  '    tar -xJf "$node_stage/node.tar.xz" --strip-components=1 -C "$node_stage/runtime"',
  '    mv "$node_stage/runtime" "$node_dir"',
  '    rm -rf "$node_stage"',
  "    trap - EXIT",
  "  fi",
  '  export PATH="$node_dir/bin:$PATH"',
  "fi",
].join("\n")

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz"

/**
 * An Ortam ID as the API takes it now. Ortam's public IDs became `<kind>_<26 base32>` (the
 * TypeID encoding of the UUID it stores), and it refuses the bare UUIDs it used to return. A
 * sandbox or operation Derive saved before that change is the same resource under its old
 * spelling, so it is re-encoded on the way out; an ID already in the new form passes through.
 */
export const ortamId = (kind: "sbx" | "op" | "spt", id: string): string => {
  if (!UUID.test(id)) return id
  let n = BigInt(`0x${id.replaceAll("-", "")}`)
  let out = ""
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(n & 31n)] + out
    n >>= 5n
  }
  return `${kind}_${out}`
}

class OrtamHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`Ortam returned HTTP ${status}`)
  }
}

/** Operator-configured API only. Redirects and response bodies never enter errors/logs. */
export class OrtamClient implements SandboxClient {
  readonly stopTimer = "idle"
  private readonly fetcher: typeof fetch

  constructor(
    readonly base: string,
    private key: string,
    /** One integration subject per agent: its sandbox belongs to that identity. */
    private subject: string,
    fetcher: typeof fetch = fetch,
    private mode: "integration" | "api_key" = "integration",
  ) {
    this.fetcher = unbound(fetcher)
    const url = new URL(base)
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/v1" ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      )
    )
      throw new Error("Ortam requires an HTTPS /v1 API URL (or local HTTP)")
  }
  private async json(path: string, init: RequestInit) {
    let response: Response
    try {
      response = await this.fetcher(this.base + path, {
        ...init,
        // workerd does not support redirect: "error". Reject 3xx below instead.
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      throw new Error("Ortam request outcome is unknown")
    }
    if (!response.ok) throw new OrtamHttpError(response.status, path)
    if (response.status === 204) return null
    try {
      return await response.json()
    } catch {
      throw new Error("Ortam returned invalid JSON")
    }
  }
  /** The integration identity this agent's subject acts as. Ortam takes the key as the bearer
   *  on every call; it has no token exchange. */
  async authenticate() {
    if (this.mode === "api_key") {
      if (this.access && this.access.expires > Date.now() + 30_000) return this.access.identity
      const result = z
        .object({ token: z.string() })
        .parse(await this.json("/auth/token", { headers: { "X-API-Key": this.key } }))
      // This token comes directly from the trusted HTTPS token endpoint. Claims project
      // identity only; Ortam validates the bearer on every resource request.
      const claims = z
        .object({
          sub: z.string().min(1),
          organization_id: z.string().min(1),
          exp: z.number(),
          scopes: z.array(z.string()),
        })
        .parse(decodeJwt(result.token))
      if (
        claims.exp * 1000 <= Date.now() ||
        !["sandboxes:read", "sandboxes:write"].every((scope) => claims.scopes.includes(scope))
      )
        throw new Error("Ortam key requires sandbox read and write access")
      const identity = { organization_id: claims.organization_id, user_id: claims.sub }
      this.access = { token: result.token, expires: claims.exp * 1000, identity }
      return identity
    }
    return z
      .object({ organization_id: z.string(), user_id: z.string() })
      .parse(await this.json("/integration", { headers: this.auth() }))
  }
  private access?: {
    token: string
    expires: number
    identity: { organization_id: string; user_id: string }
  }

  private auth(): Record<string, string> {
    return this.mode === "api_key"
      ? { Authorization: `Bearer ${this.access?.token}` }
      : { Authorization: `Bearer ${this.key}`, "X-Ortam-Integration-Subject": this.subject }
  }
  async request(
    path: string,
    identity: { organization_id: string; user_id: string },
    method = "GET",
    body?: unknown,
    key?: string,
    headers?: Record<string, string>,
  ) {
    const auth = await this.authenticate()
    if (auth.organization_id !== identity.organization_id || auth.user_id !== identity.user_id)
      throw new Error("Ortam credential ownership changed")
    return this.json(path, {
      method,
      headers: {
        ...this.auth(),
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  async create(
    body: SandboxCreate,
    key: string,
    identity: { organization_id: string; user_id: string },
  ) {
    if (body.environment)
      throw new SandboxCreateRejected("Ortam does not support Boat environments")
    if (
      body.snapshot &&
      !UUID.test(body.snapshot) &&
      !/^spt_[0-7][0-9abcdefghjkmnpqrstvwxyz]{25}$/.test(body.snapshot)
    )
      throw new SandboxCreateRejected("Ortam snapshots need a snapshot ID")
    const { snapshot, environment: _environment, env, ...settings } = body
    const result = z.object({ sandbox: Sandbox, operation: Operation }).parse(
      await this.request(
        "/sandboxes",
        identity,
        "POST",
        {
          ...settings,
          ...(snapshot ? { source: { snapshot_id: ortamId("spt", snapshot) } } : {}),
          ...(env ? { variables: env } : {}),
        },
        key,
      ),
    )
    if (result.operation.sandbox_id !== result.sandbox.id || result.operation.kind !== "create")
      throw new Error("Ortam operation mismatch")
    return result
  }
  async deleteSandbox(
    id: string,
    key: string,
    identity: { organization_id: string; user_id: string },
  ) {
    id = ortamId("sbx", id)
    const op = Operation.parse(
      await this.request(
        `/sandboxes/${encodeURIComponent(id)}`,
        identity,
        "DELETE",
        undefined,
        key,
        { "X-Ortam-Confirm-Delete": id },
      ),
    )
    if (op.sandbox_id !== id || op.kind !== "delete") throw new Error("Ortam operation mismatch")
    return op
  }
  async sandbox(id: string, identity: { organization_id: string; user_id: string }) {
    id = ortamId("sbx", id)
    const sandbox = Sandbox.parse(
      await this.request(`/sandboxes/${encodeURIComponent(id)}`, identity),
    )
    if (sandbox.id !== id) throw new Error("Ortam sandbox mismatch")
    return sandbox
  }
  async isSandboxDeleted(id: string, identity: { organization_id: string; user_id: string }) {
    id = ortamId("sbx", id)
    try {
      return (await this.sandbox(id, identity)).state === "deleted"
    } catch (error) {
      // Ortam hides a sandbox only after cleanup is committed. An auth/operation 404,
      // changed identity, or transport failure does not establish sandbox deletion.
      if (
        error instanceof OrtamHttpError &&
        error.status === 404 &&
        error.path === `/sandboxes/${encodeURIComponent(id)}`
      )
        return true
      throw error
    }
  }
  async operation(
    id: string,
    sandboxId: string,
    kind: "create" | "resume" | "stop" | "delete",
    identity: { organization_id: string; user_id: string },
  ) {
    id = ortamId("op", id)
    sandboxId = ortamId("sbx", sandboxId)
    const op = Operation.parse(
      await this.request(`/operations/${encodeURIComponent(id)}`, identity),
    )
    if (op.id !== id || op.sandbox_id !== sandboxId || op.kind !== kind)
      throw new Error("Ortam operation mismatch")
    return op
  }
  async lifecycle(
    id: string,
    action: "resume" | "stop",
    key: string,
    identity: { organization_id: string; user_id: string },
    _env?: Record<string, string>,
    machine: SandboxMachine = {},
  ) {
    if (action === "resume" && machine.environment)
      throw new Error("Ortam does not support Boat environments")
    id = ortamId("sbx", id)
    const op = Operation.parse(
      await this.request(
        `/sandboxes/${encodeURIComponent(id)}/${action}`,
        identity,
        "POST",
        undefined,
        key,
      ),
    )
    if (op.sandbox_id !== id || op.kind !== action) throw new Error("Ortam operation mismatch")
    return op
  }
  async launch(
    id: string,
    body: SandboxLaunch,
    key: string,
    identity: { organization_id: string; user_id: string },
  ) {
    id = ortamId("sbx", id)
    const { keep_awake = true, ...launch } = body
    return Process.parse(
      await this.request(
        `/sandboxes/${encodeURIComponent(id)}/processes`,
        identity,
        "POST",
        {
          ...launch,
          ...(keep_awake ? { keep_awake: true } : {}),
          ...(this.mode === "api_key"
            ? {
                argv: launch.argv.map((arg, index) =>
                  index === 2 && launch.argv[0] === "sh" && launch.argv[1] === "-c"
                    ? `${PUBLIC_RUNNER_SETUP}\n${arg}`
                    : arg,
                ),
              }
            : {}),
        },
        key,
      ),
    )
  }

  async process(
    sandboxId: string,
    id: string,
    identity: { organization_id: string; user_id: string },
  ) {
    sandboxId = ortamId("sbx", sandboxId)
    const process = Process.parse(
      await this.request(
        `/sandboxes/${encodeURIComponent(sandboxId)}/processes/${encodeURIComponent(id)}?tail_bytes=1`,
        identity,
      ),
    )
    if (process.id !== id) throw new Error("Ortam process mismatch")
    return process
  }
}

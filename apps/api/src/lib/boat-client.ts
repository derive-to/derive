import { unbound } from "@derive/broker"
import { z } from "zod"
import { sha256 } from "./crypto"
import {
  type SandboxClient,
  type SandboxCreate,
  SandboxCreateRejected,
  type SandboxMachine,
  SandboxRateLimited,
} from "./sandbox-client"

const Box = z.object({
  id: z.string(),
  state: z.string(),
  createdById: z.string().nullish(),
  archiveAfter: z.string().nullish(),
  setupStatus: z.string().nullish(),
  /** False while a restored disk is still copying in. */
  hydrated: z.boolean().nullish(),
  stop: z.object({ id: z.string(), status: z.string() }).nullish(),
})
type Identity = { organization_id: string; user_id: string }
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const op = (kind: string, id: string, state: "running" | "succeeded" | "failed" = "running") => ({
  id: `${kind}:${id}`,
  sandbox_id: id,
  kind,
  state,
})

/** boat.dev: the same Agent/Job lifecycle through its public v1 API. Creates are
 * idempotent. Commands submit once. A stop is complete only after its saved-disk receipt. */
export class BoatClient implements SandboxClient {
  private readonly fetcher: typeof fetch
  constructor(
    readonly base: string,
    private key: string,
    fetcher: typeof fetch = fetch,
  ) {
    this.fetcher = unbound(fetcher)
    const url = new URL(base)
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      )
    )
      throw new Error("boat.dev requires an HTTPS API URL (or local HTTP)")
  }
  private async request(path: string, method = "GET", body?: unknown, key?: string) {
    let response: Response
    try {
      response = await this.fetcher(this.base + path, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(75_000),
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      throw new Error("boat.dev request outcome is unknown")
    }
    if (response.status === 429) {
      const body = (await response.json().catch(() => null)) as { message?: unknown } | null
      const after = Number(response.headers.get("retry-after"))
      throw new SandboxRateLimited(
        typeof body?.message === "string" ? body.message : "boat.dev rate limit reached",
        Number.isFinite(after) && after > 0 ? after : 60,
      )
    }
    if (!response.ok) {
      const message = `boat.dev returned HTTP ${response.status}`
      if (method === "POST" && path === "/sandboxes" && [400, 404, 422].includes(response.status))
        throw new SandboxCreateRejected(message)
      throw new Error(message)
    }
    try {
      return await response.json()
    } catch {
      throw new Error("boat.dev returned invalid JSON")
    }
  }
  async authenticate() {
    const { user } = z
      .object({ user: z.object({ id: z.string() }) })
      .parse(await this.request("/me"))
    return { organization_id: "personal", user_id: user.id }
  }
  private async owned(identity: Identity) {
    const current = await this.authenticate()
    if (
      current.user_id !== identity.user_id ||
      current.organization_id !== identity.organization_id
    )
      throw new Error("boat.dev credential ownership changed")
  }
  private async read(id: string, identity: Identity) {
    await this.owned(identity)
    const { sandbox } = z
      .object({ sandbox: Box })
      .parse(await this.request(`/sandboxes/${encodeURIComponent(id)}`))
    if (sandbox.id !== id || (sandbox.createdById && sandbox.createdById !== identity.user_id))
      throw new Error("boat.dev sandbox ownership mismatch")
    return sandbox
  }
  async create(body: SandboxCreate, key: string, identity: Identity) {
    await this.owned(identity)
    const input = z
      .object({
        setup_script: z.string(),
        auto_stop_after_seconds: z.number(),
        env: z.record(z.string(), z.string()).optional(),
        snapshot: z.string().optional(),
        environment: z.string().optional(),
      })
      .parse(body)
    const { sandbox } = z.object({ sandbox: Box }).parse(
      await this.request(
        "/sandboxes",
        "POST",
        {
          name: body.name,
          type: body.size,
          ttlSeconds: input.auto_stop_after_seconds,
          // An owner-chosen environment brings its repositories and secrets; otherwise none.
          ...(input.environment ? { environment: input.environment } : { noEnv: true }),
          ...(input.snapshot ? { from: input.snapshot } : {}),
          ...(input.env ? { env: input.env } : {}),
          snapshots: true,
          setupScript: `sudo install -d -o "$(id -u)" -g "$(id -g)" /home/ortam\n${input.setup_script}`,
          org: "personal",
        },
        key,
      ),
    )
    return { sandbox: this.normalize(sandbox), operation: op("create", sandbox.id) }
  }
  private normalize(box: z.infer<typeof Box>) {
    const stopped = box.state === "archived" && box.stop?.status === "completed"
    return {
      id: box.id,
      state: stopped
        ? "stopped"
        : ["ready", "idle", "running"].includes(box.state)
          ? "ready"
          : box.state,
      current_operation_id: box.stop?.id ?? null,
      // Enforced at create and resume. The job deadline also stops a quiet runner.
      auto_stop_after_seconds: box.archiveAfter
        ? Math.max(0, Math.ceil((Date.parse(box.archiveAfter) - Date.now()) / 1000))
        : 0,
    }
  }
  async sandbox(id: string, identity: Identity) {
    return this.normalize(await this.read(id, identity))
  }
  async lifecycle(
    id: string,
    action: "resume" | "stop",
    key: string,
    identity: Identity,
    _env?: Record<string, string>,
    machine: SandboxMachine = {},
  ) {
    await this.read(id, identity)
    await this.request(
      `/sandboxes/${encodeURIComponent(id)}/${action}`,
      "POST",
      action === "resume"
        ? {
            ttlSeconds: machine.ttl_seconds ?? 1200,
            type: machine.size ?? "small",
            ...(machine.environment ? { environment: machine.environment } : { noEnv: true }),
          }
        : {},
      key,
    )
    return op(action, id)
  }
  async operation(
    id: string,
    sandboxId: string,
    kind: "create" | "resume" | "stop" | "delete",
    identity: Identity,
  ) {
    if (id !== `${kind}:${sandboxId}`) throw new Error("boat.dev operation mismatch")
    const box = await this.read(sandboxId, identity)
    // A sandbox restored from a snapshot answers before its files are all on disk. Work must
    // not start until they are, or it sees a home directory that is still arriving.
    const ready =
      ["ready", "idle", "running"].includes(box.state) &&
      box.setupStatus !== "running" &&
      box.setupStatus !== "pending" &&
      box.hydrated !== false
    const done =
      kind === "stop" || kind === "delete"
        ? box.state === "archived" && box.stop?.status === "completed"
        : ready
    const failed =
      box.state === "error" || box.state === "cancelled" || box.setupStatus === "failed"
    return op(kind, sandboxId, done ? "succeeded" : failed ? "failed" : "running")
  }
  async launch(
    id: string,
    body: { argv: string[]; cwd: string; env: Record<string, string>; timeout_seconds: number },
    key: string,
    identity: Identity,
  ) {
    await this.read(id, identity)
    // Boat command submission has no idempotency contract. The owned runner's disk marker
    // supplies it. Two accepted commands can race, but only one can own this operation.
    const processId = `derive:${sha256(key)}`
    const existing = await this.process(id, processId, identity)
    if (existing.status !== "starting") return existing
    const dir = `/home/ortam/.derive/operations/${sha256(key)}`
    const envDir = `/home/user/.derive/operations/${sha256(key)}`
    const envFile = `${envDir}/environment-${crypto.randomUUID()}.json`
    // Boat keeps command history. Send credentials as a private file, never shell text.
    z.object({ success: z.literal(true) }).parse(
      await this.request(`/sandboxes/${encodeURIComponent(id)}/commands`, "POST", {
        command: `mkdir -p ${quote(envDir)} && chmod 700 ${quote(envDir)}`,
        timeoutSeconds: 10,
      }),
    )
    z.object({ success: z.literal(true) }).parse(
      await this.request(`/sandboxes/${encodeURIComponent(id)}/files`, "PUT", {
        path: envFile,
        content: JSON.stringify(body.env),
        encoding: "utf8",
      }),
    )
    const run = [
      'const fs = require("node:fs")',
      'const { spawnSync } = require("node:child_process")',
      "const file = process.argv[1]",
      'const env = JSON.parse(fs.readFileSync(file, "utf8"))',
      "fs.rmSync(file)",
      'const result = spawnSync(process.argv[2], process.argv.slice(3), { env: { ...process.env, ...env }, stdio: "inherit" })',
      "if (result.error) throw result.error",
      "process.exit(result.status ?? 1)",
    ].join("; ")
    const command = [
      "set -eu",
      `mkdir -p ${quote(dir)}`,
      `if ! mkdir ${quote(dir + "/claim")} 2>/dev/null; then rm -f ${quote(envFile)}; exit 0; fi`,
      `printf '%s\\n' "$$" > ${quote(dir + "/pid")}`,
      `cat /proc/sys/kernel/random/boot_id > ${quote(dir + "/boot")}`,
      `awk '{print $22}' /proc/$$/stat > ${quote(dir + "/started")}`,
      `printf running > ${quote(dir + "/state")}`,
      `trap ${quote(`printf exited > ${quote(dir + "/state")}`)} EXIT`,
      `chmod 600 ${quote(envFile)}`,
      // The runner's own output stays beside its marker, so a turn that ends without a report
      // can be read back on the machine.
      `node -e ${quote(run)} ${quote(envFile)} ${body.argv.map(quote).join(" ")} >> ${quote(dir + "/runner.log")} 2>&1`,
    ].join("\n")
    z.object({ processId: z.number().int(), success: z.literal(true) }).parse(
      await this.request(`/sandboxes/${encodeURIComponent(id)}/commands`, "POST", {
        command,
        cwd: body.cwd === "/home/ortam" ? "/home/user" : body.cwd,
        detached: true,
        timeoutSeconds: Math.min(600, body.timeout_seconds),
      }),
    )
    return { id: processId, status: "running" as const }
  }
  async process(sandboxId: string, id: string, identity: Identity) {
    await this.read(sandboxId, identity)
    if (/^derive:[a-f0-9]{64}$/.test(id)) {
      const dir = `/home/ortam/.derive/operations/${id.slice(7)}`
      const command = [
        `dir=${quote(dir)}`,
        'if [ ! -d "$dir/claim" ]; then printf starting;',
        'elif [ "$(cat "$dir/state" 2>/dev/null)" = exited ]; then printf exited;',
        'elif [ -f "$dir/pid" ] && [ "$(cat "$dir/boot" 2>/dev/null)" = "$(cat /proc/sys/kernel/random/boot_id)" ] &&',
        '[ "$(awk \'{print $22}\' "/proc/$(cat "$dir/pid")/stat" 2>/dev/null)" = "$(cat "$dir/started" 2>/dev/null)" ]; then printf running;',
        "else printf interrupted; fi",
      ].join("\n")
      const read = z.object({ success: z.literal(true), stdout: z.string() }).parse(
        await this.request(`/sandboxes/${encodeURIComponent(sandboxId)}/commands`, "POST", {
          command,
          timeoutSeconds: 10,
        }),
      )
      const status = z
        .enum(["starting", "running", "exited", "interrupted"])
        .parse(read.stdout.trim())
      return { id, status }
    }
    if (!/^\d+$/.test(id)) throw new Error("boat.dev process mismatch")
    const result = z
      .object({ processId: z.number(), status: z.enum(["running", "exited", "lost"]) })
      .parse(
        await this.request(
          `/sandboxes/${encodeURIComponent(sandboxId)}/commands/${id}?tailBytes=1`,
        ),
      )
    if (String(result.processId) !== id) throw new Error("boat.dev process mismatch")
    return { id, status: result.status === "lost" ? ("interrupted" as const) : result.status }
  }
  // Retirement archives the sandbox and preserves its files. The agent drops the retired id;
  // provider retention handles permanent deletion. Never discard a failed disk save.
  async deleteSandbox(id: string, key: string, identity: Identity) {
    await this.lifecycle(id, "stop", key, identity)
    return op("delete", id)
  }
  async isSandboxDeleted(id: string, identity: Identity) {
    return (await this.sandbox(id, identity)).state === "stopped"
  }
  async sshKey(id: string, publicKey: string, identity: Identity) {
    await this.read(id, identity)
    const r = z
      .object({
        machineIp: z.string().nullish(),
        sshUser: z.string().default("user"),
        sshEndpoint: z.string().nullish(),
        hostKey: z.string().nullish(),
      })
      .parse(
        await this.request(`/sandboxes/${encodeURIComponent(id)}/sshkey`, "POST", {
          key: publicKey,
        }),
      )
    // A machine without its own public address is reached through a forwarded port.
    const [host, port] = r.sshEndpoint
      ? [
          r.sshEndpoint.slice(0, r.sshEndpoint.lastIndexOf(":")),
          Number(r.sshEndpoint.split(":").at(-1)),
        ]
      : [r.machineIp, 22]
    if (!host || !Number.isInteger(port)) throw new Error("boat.dev gave no SSH address")
    return { host, port, user: r.sshUser, host_key: r.hostKey ?? null }
  }
  async usage(id: string, since: string, until: string, identity: Identity) {
    await this.read(id, identity)
    const result = z
      .object({
        sandboxId: z.string(),
        seconds: z.number().nonnegative(),
        dollars: z.number().nonnegative(),
        running: z.boolean(),
      })
      .parse(
        await this.request(
          `/sandboxes/${encodeURIComponent(id)}/usage?${new URLSearchParams({ since, until })}`,
        ),
      )
    if (result.sandboxId !== id || result.running) throw new Error("Box usage is not settled")
    return {
      billable_seconds: result.seconds,
      cost_micro_usd: Math.round(result.dollars * 1_000_000),
    }
  }
}

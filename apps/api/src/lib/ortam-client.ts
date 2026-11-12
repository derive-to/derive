import { scryptSync } from "node:crypto"
import { unbound } from "@derive/broker"
import { z } from "zod"
import { sha256 } from "./crypto"
import {
  type SandboxClient,
  type SandboxCreate,
  SandboxCreateRejected,
  type SandboxLaunch,
  type SandboxMachine,
  SandboxRateLimited,
  SandboxRefused,
  type SandboxSshAccess,
} from "./sandbox-client"

type Identity = { organization_id: string; user_id: string }

const Sandbox = z.object({ id: z.string(), phase: z.string() })
const Operation = z.object({
  id: z.string(),
  kind: z.string(),
  resource_id: z.string(),
  state: z.enum(["pending", "running", "completed", "failed", "unknown"]),
  result: z
    .object({ final_save: z.object({ state: z.string() }).optional() })
    .nullish()
    .catch(null),
})
const Execution = z.object({
  id: z.string(),
  sandbox_id: z.string(),
  state: z.enum([
    "accepted",
    "running",
    "exited",
    "not_launched",
    "launch_failed",
    "timed_out",
    "interrupted",
    "resource_exhausted",
    "infrastructure_lost",
    "unknown",
  ]),
  exit_code: z.number().int().nullish(),
})
const Handle = z.object({ operation: Operation, resource: z.object({ id: z.string() }) })
const Usage = z.object({
  as_of: z.string(),
  atoms_per_unit: z.number().positive(),
  compute: z.object({
    next_after: z.number().nullish(),
    starts: z.array(
      z.object({
        running_at: z.string().nullish(),
        ended_at: z.string().nullish(),
        charge_atoms: z.string().nullish(),
        gap: z.string().nullish(),
      }),
    ),
  }),
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TYPE_ID = /^[a-z]+_([0-7][0-9a-hjkmnp-tv-z]{25})$/
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz"

/**
 * An Ortam ID as the API takes it: a bare UUID. For a while Ortam's IDs were
 * `<kind>_<26 base32>` (the TypeID spelling of the same UUID), and Derive saved some in that
 * form. Those are decoded on the way out, so a call about a sandbox from before the change
 * gets a plain "not found" instead of "malformed ID".
 */
export const ortamId = (id: string): string => {
  const encoded = TYPE_ID.exec(id)?.[1]
  if (!encoded) return id
  let n = 0n
  for (const char of encoded) n = (n << 5n) | BigInt(CROCKFORD.indexOf(char))
  const hex = n.toString(16).padStart(32, "0")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Ortam has no stop timer: a started sandbox runs, and bills, until someone stops it. So the
 * machine carries its own. A service Derive installs on the saved disk powers the machine off
 * at the deadline in /run/derive-stop-at (Ortam saves the files and reports it stopped), and
 * every command this adapter submits first sets that deadline, `$1` seconds from now. The
 * service starts with the machine, so one that something else woke (an SSH login starts a
 * stopped sandbox) still powers off, fifteen minutes after boot. If the deadline cannot be
 * set or the service will not start, the command does not run.
 *
 * It also makes /home/ortam, where Derive keeps its runner on every provider, and enters `$2`
 * itself: Ortam refuses a command whose working directory does not exist yet.
 *
 * The task runs as a user with sudo, so this bounds a machine nobody is driving, not one whose
 * occupant sets out to keep it up. The controller's own stop remains the ordinary path.
 */
export const ARMED = [
  "set -eu",
  '[ -d /home/ortam ] || sudo install -d -o "$(id -u)" -g "$(id -g)" /home/ortam',
  // Enabling is the install's last step, so one cut short is redone, never half trusted.
  "if ! { [ -x /usr/local/sbin/derive-stop-1 ] && systemctl is-enabled --quiet derive-stop.service; }; then",
  "  sudo tee /usr/local/sbin/derive-stop-1 >/dev/null <<'DERIVE_STOP'",
  "#!/bin/sh",
  "(set -C; echo $(($(date +%s) + 900)) > /run/derive-stop-at) 2>/dev/null || :",
  'while sleep 15; do [ "$(date +%s)" -lt "$(cat /run/derive-stop-at)" ] || poweroff; done',
  "DERIVE_STOP",
  "  sudo chmod 755 /usr/local/sbin/derive-stop-1",
  "  sudo tee /etc/systemd/system/derive-stop.service >/dev/null <<'DERIVE_STOP'",
  "[Unit]",
  "Description=Power this machine off at the deadline Derive set",
  "[Service]",
  "ExecStart=/usr/local/sbin/derive-stop-1",
  "Restart=always",
  "[Install]",
  "WantedBy=multi-user.target",
  "DERIVE_STOP",
  "  sudo systemctl daemon-reload",
  "  sudo systemctl enable derive-stop.service >/dev/null 2>&1",
  "fi",
  // Written whole, then renamed: the service powers off on a deadline it cannot read.
  'echo "$(($(date +%s) + $1))" | sudo tee /run/derive-stop-at.new >/dev/null',
  "sudo mv /run/derive-stop-at.new /run/derive-stop-at",
  "sudo systemctl start derive-stop.service",
  'cd "$2"',
  "shift 2",
  'exec "$@"',
].join("\n")
/** Room to stop cleanly after a command's own timeout, before the machine powers off. */
const STOP_SLACK_SECONDS = 600
const SSH_ENDPOINT = "https://get.ortam.dev/endpoint.json"
/** The prefix of every SSH entry Derive lists on a sandbox. */
const SSH_USER = "derive-"

const BUSY: Record<string, string> = {
  organization_machine_limit_reached: "The Ortam organization has all its machines in use",
  execution_limit_reached: "The Ortam sandbox is running as many commands as it may",
}
const REFUSED: Record<string, string> = {
  organization_not_approved: "The Ortam organization is waiting for approval",
  admission_closed: "Ortam is not admitting new sandboxes",
  organization_limit_reached: "The Ortam organization has reached its limit",
  organization_sandbox_limit_reached: "The Ortam organization has as many sandboxes as it may",
  organization_storage_limit_reached: "The Ortam organization is out of storage",
}

class OrtamHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    /** Ortam's machine-readable reason, from its fixed vocabulary. */
    readonly code?: string,
  ) {
    super(`Ortam returned HTTP ${status}${code ? ` (${code})` : ""}`)
  }
}

/** Operator-configured API only. Redirects and response prose never enter errors/logs. */
export class OrtamClient implements SandboxClient {
  readonly stopTimer = "armed"
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
      url.pathname !== "/v1" ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      )
    )
      throw new Error("Ortam requires an HTTPS /v1 API URL (or local HTTP)")
  }

  private async send(path: string, init: RequestInit = {}) {
    let response: Response
    try {
      response = await this.fetcher(this.base + path, {
        ...init,
        headers: { Authorization: `Bearer ${this.key}`, ...init.headers },
        // workerd rejects the "error" redirect mode. Reject 3xx below instead.
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      throw new Error("Ortam request outcome is unknown")
    }
    if (response.ok) return response
    const body = (await response.json().catch(() => null)) as { code?: unknown } | null
    const code =
      typeof body?.code === "string" && /^[a-z_]{1,64}$/.test(body.code) ? body.code : undefined
    if (response.status === 429) {
      const after = Number(response.headers.get("retry-after"))
      throw new SandboxRateLimited(
        "Ortam rate limit reached",
        Number.isFinite(after) && after > 0 ? after : 60,
      )
    }
    // Ortam's standing refusals, in words a person can act on. One that clears by itself
    // (machines in use) is a wait; one that needs the account changed fails the task.
    if (code && code in BUSY) throw new SandboxRateLimited(BUSY[code] as string, 120)
    if (code && code in REFUSED) throw new SandboxRefused(REFUSED[code] as string)
    throw new OrtamHttpError(response.status, path, code)
  }

  /** `key` makes a mutation safe to repeat: Ortam answers the same key and input with the
   *  first result for 24 hours, and requires one on every mutation. */
  private async json(path: string, method = "GET", body?: unknown, key?: string) {
    const response = await this.send(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(key ? { "Idempotency-Key": key.length > 128 ? sha256(key) : key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    try {
      return await response.json()
    } catch {
      throw new Error("Ortam returned invalid JSON")
    }
  }

  /** Ortam's key is the whole credential: there is no token exchange and no "who am I". This
   *  proves the key works. With nothing to name the organization behind it, the identity is
   *  a fingerprint of the key: a different key is a different account until its sandboxes
   *  are retired, because a key from another organization would see none of them. The
   *  fingerprint is saved, so it is a slow, salted derivation and not a plain hash. */
  async authenticate(): Promise<Identity> {
    await this.json("/sandboxes?limit=1")
    this.account ??= scryptSync(this.key, "derive-ortam-account", 12).toString("hex")
    return { organization_id: new URL(this.base).host, user_id: `key-${this.account}` }
  }
  private account?: string

  private path(id: string, rest = "") {
    return `/sandboxes/${encodeURIComponent(ortamId(id))}${rest}`
  }

  /** Run `argv` in the sandbox, starting it if it is stopped, with its stop timer armed. */
  private async execute(
    id: string,
    input: {
      argv: string[]
      cwd?: string
      env?: Record<string, string>
      timeout_seconds: number
      stop_after_seconds: number
    },
    key: string,
  ) {
    return Handle.parse(
      await this.json(
        this.path(id, "/executions"),
        "POST",
        {
          argv: [
            "sh",
            "-c",
            ARMED,
            "derive",
            String(Math.max(60, Math.ceil(input.stop_after_seconds))),
            input.cwd ?? "/home/ortam",
            ...input.argv,
          ],
          ...(input.env ? { env: input.env } : {}),
          timeout_seconds: Math.max(1, Math.ceil(input.timeout_seconds)),
        },
        key,
      ),
    )
  }

  private async execution(id: string) {
    return Execution.parse(await this.json(`/executions/${encodeURIComponent(id)}`))
  }

  /** A sandbox comes back stopped, with no setup of its own. The setup script is a first
   *  command, and that command is the create the caller waits on. */
  async create(body: SandboxCreate, key: string, _identity: Identity) {
    if (body.environment)
      throw new SandboxCreateRejected("Ortam does not support Boat environments")
    const snapshot = body.snapshot && ortamId(body.snapshot)
    if (snapshot && !UUID.test(snapshot))
      throw new SandboxCreateRejected("Ortam snapshots need a snapshot ID")
    const created = z.object({ operation: Operation, resource: Sandbox }).parse(
      await this.json(
        "/sandboxes",
        "POST",
        {
          name: body.name,
          // Ortam has two sizes, and medium is its own default. An agent sized for a larger
          // machine elsewhere gets Ortam's largest rather than no machine at all.
          ...(body.size === "small" ? { size: "small" } : {}),
          ...(snapshot ? { snapshot_id: snapshot } : {}),
        },
        key,
      ).catch((error) => {
        if (error instanceof OrtamHttpError && [400, 404, 422].includes(error.status))
          throw new SandboxCreateRejected(error.message)
        throw error
      }),
    )
    const id = created.resource.id
    if (created.operation.resource_id !== id || created.operation.kind !== "create")
      throw new Error("Ortam operation mismatch")
    const setup = await this.execute(
      id,
      {
        argv: ["sh", "-c", body.setup_script],
        env: body.env,
        timeout_seconds: body.auto_stop_after_seconds,
        stop_after_seconds: body.auto_stop_after_seconds,
      },
      `${key}-setup`,
    ).catch((error) => {
      // The sandbox exists by now. To the caller a rate limit or refusal proves nothing was
      // allocated, so here it is only a create whose outcome is unknown: replayed, never
      // forgotten. The error names the sandbox for a caller that will not replay.
      const unknown =
        error instanceof SandboxRateLimited || error instanceof SandboxRefused
          ? new Error("Ortam request outcome is unknown")
          : error
      throw Object.assign(unknown, { sandbox_id: id })
    })
    return {
      sandbox: this.shaped(created.resource),
      operation: {
        id: setup.operation.id,
        sandbox_id: id,
        kind: "create",
        state: "queued" as const,
      },
    }
  }

  /** Ortam calls a sandbox with compute `running`; the controller's word for it is `ready`.
   *  One Ortam `lost` has no compute either, and keeps the files it last saved: it reads as
   *  stopped, so a turn ends there and the next start decides whether it comes back. */
  private shaped(sandbox: z.infer<typeof Sandbox>) {
    return {
      id: sandbox.id,
      state:
        sandbox.phase === "running"
          ? "ready"
          : sandbox.phase === "lost"
            ? "stopped"
            : sandbox.phase,
      current_operation_id: null,
      auto_stop_after_seconds: 0,
    }
  }

  async deleteSandbox(id: string, key: string, _identity: Identity) {
    id = ortamId(id)
    const { operation } = z
      .object({ operation: Operation })
      .parse(await this.json(this.path(id), "DELETE", undefined, key))
    if (operation.resource_id !== id || operation.kind !== "delete")
      throw new Error("Ortam operation mismatch")
    return { id: operation.id, sandbox_id: id, kind: "delete", state: settled(operation) }
  }

  async sandbox(id: string, _identity: Identity) {
    id = ortamId(id)
    const sandbox = Sandbox.parse(await this.json(this.path(id)))
    if (sandbox.id !== id) throw new Error("Ortam sandbox mismatch")
    return this.shaped(sandbox)
  }

  /** Not found, or refused because the sandbox is deleted: either way it may be gone. */
  notFound(error: unknown) {
    return (
      error instanceof OrtamHttpError && (error.status === 404 || error.code === "sandbox_deleted")
    )
  }

  /** Ortam keeps a deleted sandbox's record, marked `deleted`; one it never had, or that
   *  belongs to another organization, is not found. */
  async isSandboxDeleted(id: string, identity: Identity) {
    try {
      return (await this.sandbox(id, identity)).state === "deleted"
    } catch (error) {
      if (error instanceof OrtamHttpError && error.status === 404 && error.path === this.path(id))
        return true
      throw error
    }
  }

  /** Create and resume are commands here (setup, and the start that arms the stop timer), so
   *  their operations settle when the command exits: zero is success. */
  async operation(
    id: string,
    sandboxId: string,
    kind: "create" | "resume" | "stop" | "delete",
    _identity: Identity,
  ) {
    id = ortamId(id)
    sandboxId = ortamId(sandboxId)
    const op = Operation.parse(await this.json(`/operations/${encodeURIComponent(id)}`))
    if (op.id !== id) throw new Error("Ortam operation mismatch")
    if (kind === "create" || kind === "resume") {
      if (op.kind !== "execute") throw new Error("Ortam operation mismatch")
      const ran = await this.execution(op.resource_id)
      if (ran.sandbox_id !== sandboxId) throw new Error("Ortam operation mismatch")
      const state =
        ran.state === "accepted"
          ? ("queued" as const)
          : ran.state === "running"
            ? ("running" as const)
            : ran.state === "exited" && ran.exit_code === 0
              ? ("succeeded" as const)
              : ("failed" as const)
      return { id, sandbox_id: sandboxId, kind, state }
    }
    if (op.resource_id !== sandboxId || op.kind !== kind)
      throw new Error("Ortam operation mismatch")
    return { id, sandbox_id: sandboxId, kind, state: settled(op) }
  }

  async lifecycle(
    id: string,
    action: "resume" | "stop",
    key: string,
    _identity: Identity,
    _env?: Record<string, string>,
    machine: SandboxMachine = {},
  ) {
    if (action === "resume" && machine.environment)
      throw new Error("Ortam does not support Boat environments")
    id = ortamId(id)
    // The turn's SSH keys end with it, and none carry into the next.
    await this.revokeSsh(id)
    if (action === "resume") {
      // A command starts a stopped sandbox, so the start and its stop timer are one request.
      const started = await this.execute(
        id,
        {
          argv: ["true"],
          timeout_seconds: 60,
          stop_after_seconds: machine.ttl_seconds ?? 3600,
        },
        key,
      )
      return { id: started.operation.id, sandbox_id: id, kind: action, state: "queued" as const }
    }
    const { operation } = z
      .object({ operation: Operation })
      .parse(await this.json(this.path(id, "/stop"), "POST", undefined, key))
    if (operation.resource_id !== id || operation.kind !== "stop")
      throw new Error("Ortam operation mismatch")
    return { id: operation.id, sandbox_id: id, kind: action, state: settled(operation) }
  }

  /** An SSH login starts a stopped sandbox by itself, with no stop timer armed. So a key
   *  Derive listed must not outlive the turn it was listed for. */
  private async revokeSsh(id: string) {
    const listed = z
      .array(z.object({ user_id: z.string(), public_keys: z.array(z.string()) }))
      .parse(await this.json(this.path(id, "/ssh-access")))
    for (const entry of listed)
      if (entry.user_id.startsWith(SSH_USER) && entry.public_keys.length)
        await this.json(
          this.path(id, "/ssh-access"),
          "POST",
          { user_id: entry.user_id, public_keys: [] },
          crypto.randomUUID(),
        )
  }

  async launch(id: string, body: SandboxLaunch, key: string, _identity: Identity) {
    const { resource } = await this.execute(
      id,
      {
        argv: body.argv,
        cwd: body.cwd,
        env: body.env,
        timeout_seconds: body.timeout_seconds,
        stop_after_seconds: body.timeout_seconds + STOP_SLACK_SECONDS,
      },
      key,
    )
    return { id: resource.id, status: "starting" as const }
  }

  /** Output outlives the sandbox's compute, so the tails are read once the command is over. */
  async process(sandboxId: string, id: string, _identity: Identity, tailBytes = 1) {
    id = ortamId(id)
    const ran = await this.execution(id)
    if (ran.id !== id || ran.sandbox_id !== ortamId(sandboxId))
      throw new Error("Ortam process mismatch")
    if (ran.state === "accepted") return { id, status: "starting" as const }
    if (ran.state === "running") return { id, status: "running" as const }
    const tail = Math.min(65_536, Math.floor(tailBytes))
    const [stdout, stderr] =
      tail > 1
        ? await Promise.all([this.tail(id, "stdout", tail), this.tail(id, "stderr", tail)])
        : []
    const status =
      ran.state === "exited" || ran.state === "timed_out" || ran.state === "interrupted"
        ? ran.state
        : ("failed" as const)
    return {
      id,
      status,
      ...(typeof ran.exit_code === "number" ? { exit_code: ran.exit_code } : {}),
      ...(status === "failed" ? { reason: ran.state } : {}),
      ...(stdout ? { stdout } : {}),
      ...(stderr ? { stderr } : {}),
    }
  }

  /** The last `bytes` of a stream, or nothing: a tail is a diagnostic, never worth a failure. */
  private async tail(id: string, stream: "stdout" | "stderr", bytes: number) {
    try {
      const path = `/executions/${encodeURIComponent(id)}/output`
      const status = z
        .object({ [stream]: z.object({ durable_end: z.number().int().nonnegative() }) })
        .parse(await this.json(path))
      const end = (status[stream] as { durable_end: number }).durable_end
      if (!end) return undefined
      const response = await this.send(
        `${path}/${stream}?offset=${Math.max(0, end - bytes)}&limit=${bytes}`,
      )
      return await response.text()
    } catch {
      return undefined
    }
  }

  /** SSH is direct: Ortam's gateway takes the sandbox ID as the user and any key the sandbox
   *  lists. Each key is its own entry, so adding one ends nobody else's session. */
  async sshKey(id: string, publicKey: string, _identity: Identity): Promise<SandboxSshAccess> {
    id = ortamId(id)
    let endpoint: unknown
    try {
      const response = await this.fetcher(SSH_ENDPOINT, {
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      })
      endpoint = response.ok ? await response.json() : null
    } catch {
      throw new Error("Ortam SSH endpoint is unavailable")
    }
    const gateway = z
      .object({
        ssh_host: z.string().regex(/^[a-z0-9.-]+$/i),
        ssh_port: z.number().int().min(1).max(65535),
        ssh_host_key: z.string().regex(/^ssh-ed25519 [A-Za-z0-9+/=]+$/),
      })
      .parse(endpoint)
    // Listing a key replaces its entry, so a repeat is harmless; a reused idempotency key
    // would instead replay an old answer without listing a key revoked since.
    await this.json(
      this.path(id, "/ssh-access"),
      "POST",
      { user_id: `${SSH_USER}${sha256(publicKey).slice(0, 32)}`, public_keys: [publicKey] },
      crypto.randomUUID(),
    )
    return {
      transport: "direct",
      host: gateway.ssh_host,
      port: gateway.ssh_port,
      user: id,
      host_key: gateway.ssh_host_key,
    }
  }

  /** What the window cost: each start's charge, by the share of its run inside the window.
   *  Ortam bills whole minutes per start, and a start still running is charged to date. A
   *  start it could not price or time makes the whole answer unknown, never a low number. */
  async usage(id: string, since: string, until: string, _identity: Identity) {
    const from = Date.parse(since)
    const to = Date.parse(until)
    let seconds = 0
    let atoms = 0
    let unit = 1
    let after: number | null | undefined
    for (let page = 0; page < 50; page++) {
      const report = Usage.parse(
        await this.json(this.path(id, `/usage${after == null ? "" : `?after=${after}`}`)),
      )
      unit = report.atoms_per_unit
      for (const start of report.compute.starts) {
        if (!start.running_at) continue
        const began = Date.parse(start.running_at)
        const ended = Date.parse(start.ended_at ?? report.as_of)
        const inside = Math.min(ended, to) - Math.max(began, from)
        if (!(inside > 0) || !(ended > began)) continue
        if (start.gap || start.charge_atoms == null) throw new Error("Ortam usage is not settled")
        seconds += inside / 1000
        atoms += (Number(start.charge_atoms) * inside) / (ended - began)
      }
      after = report.compute.next_after
      if (after == null) {
        return {
          billable_seconds: Math.ceil(seconds),
          cost_micro_usd: Math.round((atoms / unit) * 1_000_000),
        }
      }
    }
    throw new Error("Ortam usage is not settled")
  }
}

/** An operation Ortam cannot account for is not a success: the caller reads the sandbox. Nor
 *  is a stop that did not save the files. The controller takes a sandbox that reads stopped
 *  as stopped before it asks after the operation, so this decides only a stop still under
 *  way; a turn whose final save failed resumes from the save before it. */
const settled = (op: z.infer<typeof Operation>) => {
  if (op.state === "pending") return "queued" as const
  if (op.state === "running") return "running" as const
  const save = op.kind === "stop" ? op.result?.final_save?.state : undefined
  const saved = save === undefined || save === "published" || save === "not_required"
  return op.state === "completed" && saved ? ("succeeded" as const) : ("failed" as const)
}

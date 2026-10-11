import { unbound } from "@derive/broker"
import { z } from "zod"
import type { SandboxClient } from "./sandbox-client"

const Box = z.object({
  id: z.string(),
  state: z.string(),
  createdById: z.string().nullish(),
  archiveAfter: z.string().nullish(),
  setupStatus: z.string().nullish(),
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

/** Box (now Boat): the same Agent/Job lifecycle through its public v1 API. Creates are
 * idempotent. Commands submit once. A stop is complete only after its saved-disk receipt. */
export class BoxClient implements SandboxClient {
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
      throw new Error("Box requires an HTTPS API URL (or local HTTP)")
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
      throw new Error("Box request outcome is unknown")
    }
    if (!response.ok) throw new Error(`Box returned HTTP ${response.status}`)
    try {
      return await response.json()
    } catch {
      throw new Error("Box returned invalid JSON")
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
      throw new Error("Box credential ownership changed")
  }
  private async read(id: string, identity: Identity) {
    await this.owned(identity)
    const { sandbox } = z
      .object({ sandbox: Box })
      .parse(await this.request(`/sandboxes/${encodeURIComponent(id)}`))
    if (sandbox.id !== id || (sandbox.createdById && sandbox.createdById !== identity.user_id))
      throw new Error("Box sandbox ownership mismatch")
    return sandbox
  }
  async create(body: unknown, key: string, identity: Identity) {
    await this.owned(identity)
    const input = z
      .object({ setup_script: z.string(), auto_stop_after_seconds: z.number() })
      .parse(body)
    const { sandbox } = z.object({ sandbox: Box }).parse(
      await this.request(
        "/sandboxes",
        "POST",
        {
          type: "small",
          ttlSeconds: input.auto_stop_after_seconds,
          noEnv: true,
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
    env?: Record<string, string>,
  ) {
    await this.read(id, identity)
    await this.request(
      `/sandboxes/${encodeURIComponent(id)}/${action}`,
      "POST",
      action === "resume" ? { ttlSeconds: 1200, noEnv: true, type: "small", env } : {},
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
    if (id !== `${kind}:${sandboxId}`) throw new Error("Box operation mismatch")
    const box = await this.read(sandboxId, identity)
    const ready =
      ["ready", "idle", "running"].includes(box.state) &&
      box.setupStatus !== "running" &&
      box.setupStatus !== "pending"
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
    _key: string,
    identity: Identity,
  ) {
    await this.read(id, identity)
    // Resume installs the scoped environment. Command history keeps command text for
    // 90 days: credentials must never be interpolated into it.
    const command = `test -n "$DERIVE_TOKEN" && exec ${body.argv.map(quote).join(" ")}`
    const result = z.object({ processId: z.number().int(), success: z.literal(true) }).parse(
      await this.request(`/sandboxes/${encodeURIComponent(id)}/commands`, "POST", {
        command,
        cwd: body.cwd === "/home/ortam" ? "/home/user" : body.cwd,
        detached: true,
        timeoutSeconds: Math.min(600, body.timeout_seconds),
      }),
    )
    return { id: String(result.processId), status: "running" as const }
  }
  async process(sandboxId: string, id: string, identity: Identity) {
    await this.read(sandboxId, identity)
    if (!/^\d+$/.test(id)) throw new Error("Box process mismatch")
    const result = z
      .object({ processId: z.number(), status: z.enum(["running", "exited", "lost"]) })
      .parse(
        await this.request(
          `/sandboxes/${encodeURIComponent(sandboxId)}/commands/${id}?tailBytes=1`,
        ),
      )
    if (String(result.processId) !== id) throw new Error("Box process mismatch")
    return { id, status: result.status === "lost" ? ("interrupted" as const) : result.status }
  }
  // Retirement archives the Box and preserves its files. The agent drops the retired id;
  // provider retention handles permanent deletion. Never discard a failed disk save.
  async deleteSandbox(id: string, key: string, identity: Identity) {
    await this.lifecycle(id, "stop", key, identity)
    return op("delete", id)
  }
  async isSandboxDeleted(id: string, identity: Identity) {
    return (await this.sandbox(id, identity)).state === "stopped"
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

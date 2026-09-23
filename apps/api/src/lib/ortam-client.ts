import { unbound } from "@derive/broker"
import { z } from "zod"

const Sandbox = z.object({
  id: z.string(),
  state: z.string(),
  current_operation_id: z.string().nullable(),
  auto_stop_after_seconds: z.number(),
  agent_connections: z.object({ user_id: z.string() }).nullable().optional(),
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

class OrtamHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`Ortam returned HTTP ${status}`)
  }
}

/** Operator-configured API only. Redirects and response bodies never enter errors/logs. */
export class OrtamClient {
  private readonly fetcher: typeof fetch

  constructor(
    readonly base: string,
    private key: string,
    fetcher: typeof fetch = fetch,
    private subject?: string,
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
  async authenticate() {
    const response = z
      .object({ token: z.string() })
      .parse(await this.json("/auth/token", { headers: { "X-API-Key": this.key } }))
    const encoded = response.token.split(".")[1]
    if (!encoded) throw new Error("Ortam returned an invalid token")
    const claims = z
      .object({ organization_id: z.string(), sub: z.string() })
      .parse(JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/"))))
    if (this.subject) {
      const identity = z.object({ organization_id: z.string(), user_id: z.string() }).parse(
        await this.json("/integration", {
          headers: {
            Authorization: `Bearer ${response.token}`,
            "X-Ortam-Integration-Subject": this.subject,
          },
        }),
      )
      if (identity.organization_id !== claims.organization_id)
        throw new Error("Ortam integration ownership changed")
      return { ...identity, token: response.token }
    }
    return { organization_id: claims.organization_id, user_id: claims.sub, token: response.token }
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
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
        ...headers,
        ...(this.subject ? { "X-Ortam-Integration-Subject": this.subject } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  async create(body: unknown, key: string, identity: { organization_id: string; user_id: string }) {
    const result = z
      .object({ sandbox: Sandbox, operation: Operation })
      .parse(await this.request("/sandboxes", identity, "POST", body, key))
    if (result.operation.sandbox_id !== result.sandbox.id || result.operation.kind !== "create")
      throw new Error("Ortam operation mismatch")
    return result
  }
  async deleteSandbox(
    id: string,
    key: string,
    identity: { organization_id: string; user_id: string },
  ) {
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
    const sandbox = Sandbox.parse(
      await this.request(`/sandboxes/${encodeURIComponent(id)}`, identity),
    )
    if (sandbox.id !== id) throw new Error("Ortam sandbox mismatch")
    return sandbox
  }
  async isSandboxDeleted(id: string, identity: { organization_id: string; user_id: string }) {
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
  ) {
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
    body: { argv: string[]; cwd: string; env: Record<string, string>; timeout_seconds: number },
    identity: { organization_id: string; user_id: string },
  ) {
    return Process.parse(
      await this.request(`/sandboxes/${encodeURIComponent(id)}/processes`, identity, "POST", body),
    )
  }
  async process(
    sandboxId: string,
    id: string,
    identity: { organization_id: string; user_id: string },
  ) {
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

export const modelConnections = z.object({
  items: z.array(
    z.object({
      harness: z.string(),
      status: z.string(),
      identity: z.object({ email: z.string().optional() }).nullable(),
    }),
  ),
})

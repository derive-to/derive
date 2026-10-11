/** Provider adapters own API translation. The controller owns jobs, claims, and
 * retries. A stopped sandbox must mean compute is off and its files are saved. */
type Identity = { organization_id: string; user_id: string }
type Operation = {
  id: string
  sandbox_id: string
  kind: string
  state: "queued" | "running" | "succeeded" | "failed"
}
type Sandbox = {
  id: string
  state: string
  current_operation_id: string | null
  auto_stop_after_seconds: number
}
type Process = {
  id: string
  status: "starting" | "running" | "exited" | "failed" | "timed_out" | "stopped" | "interrupted"
}
export interface SandboxClient {
  authenticate(): Promise<Identity>
  create(
    body: unknown,
    key: string,
    identity: Identity,
  ): Promise<{ sandbox: Sandbox; operation: Operation }>
  sandbox(id: string, identity: Identity): Promise<Sandbox>
  operation(
    id: string,
    sandboxId: string,
    kind: "create" | "resume" | "stop" | "delete",
    identity: Identity,
  ): Promise<Operation>
  lifecycle(
    id: string,
    action: "resume" | "stop",
    key: string,
    identity: Identity,
    env?: Record<string, string>,
  ): Promise<Operation>
  launch(
    id: string,
    body: { argv: string[]; cwd: string; env: Record<string, string>; timeout_seconds: number },
    key: string,
    identity: Identity,
  ): Promise<Process>
  process(sandboxId: string, id: string, identity: Identity): Promise<Process>
  deleteSandbox(id: string, key: string, identity: Identity): Promise<Operation>
  isSandboxDeleted(id: string, identity: Identity): Promise<boolean>
  usage?(
    id: string,
    since: string,
    until: string,
    identity: Identity,
  ): Promise<{ billable_seconds: number; cost_micro_usd: number }>
}

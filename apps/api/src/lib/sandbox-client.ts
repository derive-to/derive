/** Creation was refused before allocation; transport failures are not this error. */
export class SandboxCreateRejected extends Error {}

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
export interface SandboxCreate {
  name: string
  size: "small" | "medium" | "default" | "large" | "xlarge"
  auto_stop_after_seconds: number
  setup_script: string
  snapshot?: string
  /** A provider environment to attach. Absent: the machine gets none of the account's secrets. */
  environment?: string
  env?: Record<string, string>
}
/** How a resumed machine is shaped; providers without these ignore them. */
export interface SandboxMachine {
  size?: SandboxCreate["size"]
  environment?: string
  /** Provider stop timer for the resumed turn. */
  ttl_seconds?: number
}
export interface SandboxClient {
  authenticate(): Promise<Identity>
  create(
    body: SandboxCreate,
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
    machine?: SandboxMachine,
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

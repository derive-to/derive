import { log } from "../log"
import type { Substrate } from "./dispatch"
import { RUN_TIMEOUT_MS } from "./run-lifecycle"

// The CLOUDFLARE CONTAINER substrate: hosted execution for the Workers deployment (derive.to,
// and any self-host on Cloudflare). One run = one container instance that boots, executes
// `derive runner run`, and exits — scale-to-zero, so nothing idles between runs and a run
// costs container-minutes rather than a standing VM.
//
// Deliberately thin. All the *correctness* (materialize, reclaim, mint, dispatch) lives in
// lib/dispatch.ts and is platform-agnostic; this file only knows how to boot one instance and
// hand it its token. That is what makes the Cloudflare path swappable and testable.

/** The Containers binding surface we depend on — declared structurally (not imported from a
 *  Cloudflare type package) so the API's Node build never needs the Workers types, and tests
 *  can pass a plain fake. `get` returns one addressable instance; `id` picks WHICH instance,
 *  and using the RUN ID means a re-dispatch of the same run reuses the same instance rather
 *  than racing a second one. */
export interface ContainerBinding {
  getByName?: (name: string) => ContainerInstance
  idFromName?: (name: string) => unknown
  get?: (id: unknown) => ContainerInstance
}

export interface ContainerInstance {
  /** Our own RPC (see RunContainer.startRun): boot this instance for one run. Preferred —
   *  it pins the contract to OUR class, not to the SDK's evolving start() signature. */
  startRun?: (envVars: Record<string, string>) => Promise<unknown>
  /** Fallback: the SDK's own start, for a binding that exposes it directly. */
  start?: (opts: { envVars?: Record<string, string>; enableInternet?: boolean }) => Promise<unknown>
}

export interface ContainerSubstrateOpts {
  binding: ContainerBinding
  /** Passed to the container so its exit is bounded even if the run wedges. */
  timeoutMs?: number
}

/** Resolve one instance for a run id, tolerating either binding shape (getByName, or
 *  idFromName+get). Returns null when the binding exposes neither — a misconfigured binding
 *  must degrade to "no hosted execution", never crash the tick. */
const instanceFor = (binding: ContainerBinding, runId: string): ContainerInstance | null => {
  if (typeof binding.getByName === "function") return binding.getByName(runId)
  if (typeof binding.idFromName === "function" && typeof binding.get === "function")
    return binding.get(binding.idFromName(runId))
  return null
}

/** Boot one Cloudflare Container per run, keyed BY RUN ID so a duplicate dispatch addresses
 *  the same instance instead of starting a second executor. */
export const containerSubstrate = (opts: ContainerSubstrateOpts): Substrate => ({
  name: "cf-container",
  async start({ runId, token, server }) {
    const inst = instanceFor(opts.binding, runId)
    if (!inst) throw new Error("containers binding exposes neither getByName nor idFromName/get")
    // The container's entrypoint reads these: the capability token is its ONLY credential,
    // scoped to this one run and expiring on its own. DERIVE_CONTEXT is blank because this is
    // the context-less run lane (`derive runner run`, not `serve`).
    const envVars = {
      DERIVE_TOKEN: token,
      DERIVE_SERVER: server,
      DERIVE_CONTEXT: "",
      DERIVE_RUN_TIMEOUT_MS: String(opts.timeoutMs ?? RUN_TIMEOUT_MS),
      // The coding-agent sandbox is the container itself. This lets Codex make the requested
      // workspace changes without layering a second Landlock sandbox that is unavailable in
      // the Cloudflare runtime; source credentials still never enter the container.
      DERIVE_RUNNER_ISOLATED: "1",
    }
    if (typeof inst.startRun === "function") {
      await inst.startRun(envVars)
      return
    }
    if (typeof inst.start === "function") {
      // enableInternet: the executor calls back to the Derive API and reaches the model
      // provider. Source pulls still proxy through the API, so no source credential is here.
      await inst.start({ envVars, enableInternet: true })
      return
    }
    throw new Error("container instance exposes neither startRun nor start")
  },
})

/** Build the container substrate from a Worker env, or null when the binding isn't configured
 *  (the default: hosted execution is opt-in, and an unconfigured deployment must simply leave
 *  runs queued for a polling runner rather than fail its cron). */
export const containerSubstrateFromEnv = (env: Record<string, unknown>): Substrate | null => {
  const binding = env.RUN_CONTAINER as ContainerBinding | undefined
  if (!binding || typeof binding !== "object") return null
  if (typeof binding.getByName !== "function" && typeof binding.idFromName !== "function") {
    log.warn("RUN_CONTAINER is bound but exposes no usable instance accessor — hosted runs off")
    return null
  }
  return containerSubstrate({ binding })
}

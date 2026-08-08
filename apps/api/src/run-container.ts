import { Container, type StopParams } from "@cloudflare/containers"
import { log } from "./log"

/**
 * The hosted-run container: ONE automation run per instance, then it exits.
 *
 * A job container, not a server — it accepts no traffic and nothing fetches it. The tick boots it
 * with the run's per-run capability token in the environment; the image's entrypoint sees that
 * token, executes `derive runner run` exactly once, and the process ends. Cloudflare scales the
 * instance to zero after it goes idle, so between runs there is no compute and no cost.
 *
 * Instances are addressed BY RUN ID (see substrate-container.ts), so a duplicate dispatch of the
 * same run reaches the same instance instead of racing a second executor. Even if two did boot,
 * the claim is status-guarded server-side — the loser gets an empty claim and exits clean.
 */
export class RunContainer extends Container {
  private runId: string | undefined

  /** Metadata only: start() probes this port to distinguish a running non-listener from a crash.
   *  The image never listens on it and the Worker exposes no route to the container. */
  override defaultPort = 8080
  override sleepAfter = "15m"

  /**
   * Boot this instance for one run. `envVars` carries the capability token, the API base URL,
   * and the run timeout — the token is the container's ONLY credential, it is scoped to this one
   * run, and it expires on its own. No third-party source credential ever enters here: source
   * pulls proxy back through the API's tool endpoint, which holds those server-side.
   */
  async startRun(envVars: Record<string, string>): Promise<void> {
    this.runId = envVars.DERIVE_RUN_ID
    // enableInternet: the executor calls the Derive API back (claim, pull, write, finish) and
    // the model provider directly with the run initiator's own plan.
    await this.start({
      envVars,
      enableInternet: true,
      ...(this.runId ? { labels: { run_id: this.runId } } : {}),
    })
  }

  override onStart(): void {
    log.info("hosted container started", { run_id: this.runId })
  }

  override onStop({ exitCode, reason }: StopParams): void {
    const fields = { run_id: this.runId, exit_code: exitCode, reason }
    if (exitCode === 0) log.info("hosted container stopped", fields)
    else log.warn("hosted container stopped", fields)
  }

  override onError(error: unknown): void {
    log.error("hosted container error", {
      run_id: this.runId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

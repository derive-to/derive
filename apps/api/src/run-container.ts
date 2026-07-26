import { Container } from "@cloudflare/containers"

/**
 * The hosted-run container: ONE automation run per instance, then it exits.
 *
 * A job container, not a server — it exposes no port and nothing fetches it. The tick boots it
 * with the run's per-run capability token in the environment; the image's entrypoint sees that
 * token, executes `derive runner run` exactly once, and the process ends. Cloudflare scales the
 * instance to zero after it goes idle, so between runs there is no compute and no cost.
 *
 * Instances are addressed BY RUN ID (see substrate-container.ts), so a duplicate dispatch of the
 * same run reaches the same instance instead of racing a second executor. Even if two did boot,
 * the claim is status-guarded server-side — the loser gets an empty claim and exits clean.
 */
export class RunContainer extends Container {
  /** No defaultPort: nothing connects to this container, it just runs and exits. */
  override sleepAfter = "15m"

  /**
   * Boot this instance for one run. `envVars` carries the capability token, the API base URL,
   * and the run timeout — the token is the container's ONLY credential, it is scoped to this one
   * run, and it expires on its own. No third-party source credential ever enters here: source
   * pulls proxy back through the API's tool endpoint, which holds those server-side.
   */
  async startRun(envVars: Record<string, string>): Promise<void> {
    // enableInternet: the executor calls the Derive API back (claim, pull, write, finish) and
    // the model provider directly with the run initiator's own plan.
    await this.start({ envVars, enableInternet: true })
  }
}

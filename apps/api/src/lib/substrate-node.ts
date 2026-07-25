import { spawn } from "node:child_process"
import { log } from "../log"
import type { Substrate } from "./dispatch"

// The NODE substrate: hosted execution for a self-host that already runs the API on a box.
// One run = one detached `derive runner run <token>` child process on this machine. No
// container runtime, no extra service, no always-on worker beyond the API itself — which is
// what makes this the smallest real "no machine on" story (nothing runs BEYOND the API you
// were already running) and the OSS default.
//
// The child gets ONLY its per-run capability token: no standing agent secret, and no
// third-party source credential (those stay server-side behind the tool endpoint). The model
// plan is fetched by the run itself, scoped to whoever the run bills.

export interface NodeSubstrateOpts {
  /** The derive CLI to spawn (DERIVE_RUNNER_BIN; default `derive` on PATH). */
  bin: string
  /** Hard ceiling for one run; the child is killed past it and the reclaim sweep requeues. */
  timeoutMs?: number
  /** Injectable for tests. */
  spawnImpl?: typeof spawn
}

/** Spawn `derive runner run` per run, detached, with the token in the ENV (never argv — argv
 *  is world-readable in `ps`, and this token can write artifacts). */
export const nodeSubstrate = (opts: NodeSubstrateOpts): Substrate => ({
  name: "node-child",
  async start({ runId, token, server }) {
    const spawnFn = opts.spawnImpl ?? spawn
    const child = spawnFn(opts.bin, ["runner", "run"], {
      // Inherit the ambient env (a self-host's global model key lives there), then pin this
      // run's identity. DERIVE_CONTEXT is cleared: this is the context-less run lane.
      env: {
        ...process.env,
        DERIVE_TOKEN: token,
        DERIVE_SERVER: server,
        DERIVE_CONTEXT: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      // Detached so a slow run isn't tied to an API restart; the reclaim sweep is the
      // backstop if the box goes down mid-run.
      detached: false,
    })
    const tail: string[] = []
    const keep = (b: Buffer) => {
      tail.push(b.toString())
      if (tail.length > 40) tail.shift()
    }
    child.stdout?.on("data", keep)
    child.stderr?.on("data", keep)
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 15 * 60_000)
    if (typeof timer.unref === "function") timer.unref()
    child.on("error", (err) => {
      clearTimeout(timer)
      // The commonest real failure: the CLI isn't installed. Say so plainly — a hosted run
      // silently never happening is the worst outcome.
      log.warn("hosted run: could not spawn the derive CLI", {
        run: runId,
        bin: opts.bin,
        error: err.message,
      })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) return
      log.warn("hosted run: executor exited nonzero", {
        run: runId,
        code,
        tail: tail.join("").slice(-600),
      })
    })
    // Resolve as soon as it is STARTED: the run reports its own outcome through the API.
  },
})

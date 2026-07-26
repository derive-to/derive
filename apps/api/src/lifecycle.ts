/**
 * Graceful shutdown, extracted from the Node entry so the sequence is unit-testable
 * (the entry itself boots a real server + process handlers on import). Fly's
 * auto-stop and every redeploy send SIGTERM: stop the background worker + timers,
 * stop accepting connections and drain in-flight requests, close the datastores,
 * then exit — instead of Node's default of dropping everything mid-flight.
 */
interface ShutdownLogger {
  info(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

/** The subset of a Node http.Server the shutdown touches. closeIdleConnections is
 *  optional because @hono/node-server's return type is an http2/https union. */
interface ClosableServer {
  close(cb: () => void): void
  closeIdleConnections?: () => void
}

export interface ShutdownDeps {
  server: ClosableServer
  stopWorker: () => void
  clearTimers: () => void
  closeStores: () => Promise<void>
  log: ShutdownLogger
  exit: (code: number) => void
  /** Hard deadline before a hung drain is force-exited. Defaults to 10s. */
  deadlineMs?: number
}

/**
 * Build the signal handler. The returned function is idempotent: a second signal
 * (SIGTERM then SIGINT, or a repeated SIGTERM) is a no-op while the first drain is
 * in flight. A hard deadline guarantees the process exits even if `close()` or
 * `closeStores()` hangs, so the orchestrator is never wedged.
 */
export const makeShutdown = (deps: ShutdownDeps): ((signal: string) => Promise<void>) => {
  let shuttingDown = false
  return async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    deps.log.info("shutting down", { signal })
    const deadline = setTimeout(() => {
      deps.log.error("shutdown timed out; forcing exit")
      deps.exit(1)
    }, deps.deadlineMs ?? 10_000)
    deadline.unref?.()
    deps.stopWorker()
    deps.clearTimers()
    // close() resolves once existing connections end, but Node never closes IDLE
    // keep-alive sockets on its own — a parked browser/LB connection would keep it
    // pending until the deadline. closeIdleConnections drops those now; in-flight
    // requests keep their socket and still drain.
    const drained = new Promise<void>((resolve) => deps.server.close(() => resolve()))
    deps.server.closeIdleConnections?.()
    await drained
    try {
      await deps.closeStores()
    } catch (e) {
      deps.log.error("error closing datastores", {
        error: e instanceof Error ? e.message : String(e),
      })
    }
    clearTimeout(deadline)
    deps.log.info("shutdown complete")
    deps.exit(0)
  }
}

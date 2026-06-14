import { describe, expect, it, vi } from "vitest"
import { makeShutdown, type ShutdownDeps } from "../src/lifecycle"

// A controllable server: by default close() resolves on the next tick; pass
// neverCloses to simulate a hung drain (a parked keep-alive connection).
const makeDeps = (over: Partial<ShutdownDeps> & { neverCloses?: boolean } = {}) => {
  const { neverCloses, ...rest } = over
  const log = { info: vi.fn(), error: vi.fn() }
  const exit = vi.fn()
  const closeIdleConnections = vi.fn()
  const close = vi.fn((cb: () => void) => {
    if (!neverCloses) queueMicrotask(cb)
  })
  const deps: ShutdownDeps = {
    server: { close, closeIdleConnections },
    stopWorker: vi.fn(),
    clearTimers: vi.fn(),
    closeStores: vi.fn(async () => {}),
    log,
    exit,
    ...rest,
  }
  return { deps, log, exit, close, closeIdleConnections }
}

describe("lifecycle: graceful shutdown", () => {
  it("runs the full sequence and exits 0", async () => {
    const { deps, log, exit, close, closeIdleConnections } = makeDeps()
    await makeShutdown(deps)("SIGTERM")
    expect(log.info).toHaveBeenCalledWith("shutting down", { signal: "SIGTERM" })
    expect(deps.stopWorker).toHaveBeenCalledOnce()
    expect(deps.clearTimers).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    // Idle keep-alive sockets are dropped so the drain doesn't stall on them.
    expect(closeIdleConnections).toHaveBeenCalledOnce()
    expect(deps.closeStores).toHaveBeenCalledOnce()
    expect(log.info).toHaveBeenCalledWith("shutdown complete")
    expect(exit).toHaveBeenCalledWith(0)
  })

  it("is idempotent — a second signal while draining is a no-op", async () => {
    const { deps, exit } = makeDeps()
    const shutdown = makeShutdown(deps)
    const first = shutdown("SIGTERM")
    const second = shutdown("SIGINT") // shuttingDown already set synchronously
    await Promise.all([first, second])
    expect(deps.stopWorker).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it("still exits 0 if closing the datastores throws (logs the error)", async () => {
    const { deps, log, exit } = makeDeps({
      closeStores: vi.fn(async () => {
        throw new Error("pool already ended")
      }),
    })
    await makeShutdown(deps)("SIGTERM")
    expect(log.error).toHaveBeenCalledWith(
      "error closing datastores",
      expect.objectContaining({ error: "pool already ended" }),
    )
    expect(exit).toHaveBeenCalledWith(0)
  })

  it("works when the server has no closeIdleConnections (http2/https union member)", async () => {
    const close = vi.fn((cb: () => void) => queueMicrotask(cb))
    const exit = vi.fn()
    const deps: ShutdownDeps = {
      server: { close }, // no closeIdleConnections
      stopWorker: vi.fn(),
      clearTimers: vi.fn(),
      closeStores: vi.fn(async () => {}),
      log: { info: vi.fn(), error: vi.fn() },
      exit,
    }
    await makeShutdown(deps)("SIGTERM")
    expect(exit).toHaveBeenCalledWith(0)
  })

  it("force-exits 1 when the drain hangs past the deadline", async () => {
    const { deps, log, exit } = makeDeps({ neverCloses: true, deadlineMs: 20 })
    // close() never calls back, so the shutdown promise never resolves — don't await
    // it; just let the hard deadline fire.
    void makeShutdown(deps)("SIGTERM")
    await new Promise((r) => setTimeout(r, 50))
    expect(log.error).toHaveBeenCalledWith("shutdown timed out; forcing exit")
    expect(exit).toHaveBeenCalledWith(1)
  })
})

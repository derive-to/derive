import type { Context } from "hono"

export const SESSION_FRAME_LIMIT = 1_048_576
const WRITE_TIMEOUT_MS = 30_000
const QUEUED_FRAME_LIMIT = 256

type Bytes = Uint8Array<ArrayBuffer>
type Events = { message(data: Bytes | string): void; close(): void }
export interface SessionSocket {
  send(data: Bytes): Promise<void>
  close(): void
  listen(events: Events): () => void
}
export interface SessionTransport {
  connect(request: Request, c?: Context): Promise<SessionSocket>
  watchDisconnect?(c: Context, close: () => void): () => void
  accept(c: Context, ready: (socket: SessionSocket) => void, failed: () => void): Promise<Response>
}

export function bufferedSessionSocket(write: (data: Bytes) => Promise<void>, stop: () => void) {
  let events: Events | undefined
  let ended = false
  let queued = 0
  const pending: Bytes[] = []
  const socket: SessionSocket = {
    send: write,
    close() {
      if (ended) return
      ended = true
      pending.length = 0
      stop()
      events?.close()
    },
    listen(next) {
      events = next
      if (ended) next.close()
      else {
        for (const data of pending) {
          if (ended) break
          next.message(data)
        }
        pending.length = 0
        queued = 0
      }
      return () => {
        if (events === next) events = undefined
      }
    },
  }
  return {
    socket,
    message(data: Bytes | string) {
      if (ended) return
      if (typeof data === "string" || data.byteLength > SESSION_FRAME_LIMIT) {
        socket.close()
        return
      }
      if (data.byteLength === 0) return
      if (events) events.message(data)
      else {
        queued += data.byteLength
        if (queued > SESSION_FRAME_LIMIT || pending.length >= QUEUED_FRAME_LIMIT) socket.close()
        else pending.push(data)
      }
    },
    close: () => socket.close(),
  }
}

export function relaySession(
  upstream: SessionSocket,
  stillAllowed: () => Promise<boolean>,
  deadline: number,
) {
  let downstream: SessionSocket | undefined
  let ended = false
  let detachUp: (() => void) | undefined
  let detachDown: (() => void) | undefined
  let checking = false
  let cancelAuthorization: (() => void) | undefined
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const close = () => {
    if (ended) return
    ended = true
    cancelAuthorization?.()
    clearInterval(poll)
    clearTimeout(expiry)
    for (const timer of timers) clearTimeout(timer)
    detachUp?.()
    detachDown?.()
    upstream.close()
    downstream?.close()
  }
  const authorize = async () => {
    if (ended) return false
    checking = true
    const cancelled = new Promise<boolean>((resolve) => {
      cancelAuthorization = () => resolve(false)
    })
    const timeout = setTimeout(close, 15_000)
    timers.add(timeout)
    try {
      const allowed = await Promise.race([stillAllowed(), cancelled])
      if (!allowed) close()
      return allowed && !ended
    } catch {
      close()
      return false
    } finally {
      clearTimeout(timeout)
      timers.delete(timeout)
      cancelAuthorization = undefined
      checking = false
    }
  }
  const poll = setInterval(async () => {
    if (checking || ended) return
    await authorize()
  }, 5_000)
  const expiry = setTimeout(close, Math.max(0, deadline - Date.now()))
  const pipe = (target: SessionSocket) => {
    let queued = 0
    let frames = 0
    let chain = Promise.resolve()
    return (data: Bytes | string) => {
      if (ended) return
      if (typeof data === "string" || data.byteLength > SESSION_FRAME_LIMIT) return close()
      if (data.byteLength === 0) return
      queued += data.byteLength
      frames++
      if (queued > SESSION_FRAME_LIMIT || frames > QUEUED_FRAME_LIMIT) return close()
      chain = chain.then(async () => {
        if (ended) return
        const timer = setTimeout(close, WRITE_TIMEOUT_MS)
        timers.add(timer)
        try {
          await target.send(data)
          queued -= data.byteLength
          frames--
        } catch {
          close()
        } finally {
          clearTimeout(timer)
          timers.delete(timer)
        }
      })
    }
  }
  return {
    close,
    authorize,
    ready(socket: SessionSocket) {
      downstream = socket
      if (ended) return socket.close()
      detachUp = upstream.listen({ message: pipe(socket), close })
      if (!ended) detachDown = socket.listen({ message: pipe(upstream), close })
    },
  }
}

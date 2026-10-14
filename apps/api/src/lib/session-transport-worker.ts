import {
  bufferedSessionSocket,
  SESSION_FRAME_LIMIT,
  type SessionTransport,
} from "./session-transport"

export interface WorkerSessionSocket {
  accept(): void
  send(data: ArrayBuffer | ArrayBufferView): void
  close(code?: number): void
  addEventListener(type: "message", listener: (event: { data: string | ArrayBuffer }) => void): void
  addEventListener(type: "close" | "error", listener: () => void): void
}

export function workerSessionSocket(ws: WorkerSessionSocket) {
  const buffered = bufferedSessionSocket(
    async (data) => {
      if (data.byteLength > SESSION_FRAME_LIMIT) throw new Error("SSH frame too large")
      ws.send(data)
    },
    () => ws.close(1000),
  )
  ws.addEventListener("message", (event) =>
    buffered.message(typeof event.data === "string" ? event.data : new Uint8Array(event.data)),
  )
  ws.addEventListener("close", buffered.close)
  ws.addEventListener("error", buffered.close)
  ws.accept()
  return buffered.socket
}

export function workerSessionTransport<S extends WorkerSessionSocket>(platform: {
  dial(request: Request): Promise<{ status: number; webSocket?: S | null }>
  pair(): { 0: S; 1: S }
  response(socket: S): Response
}): SessionTransport {
  const dial = platform.dial
  return {
    async connect(request) {
      if (request.signal.aborted) throw new Error("SSH tunnel connection canceled")
      return new Promise((resolve, reject) => {
        const controller = new AbortController()
        let finished = false
        const cleanup = () => {
          clearTimeout(timer)
          request.signal.removeEventListener("abort", cancel)
        }
        const cancel = () => {
          if (finished) return
          finished = true
          cleanup()
          controller.abort()
          reject(new Error("SSH tunnel connection canceled"))
        }
        const timer = setTimeout(cancel, 15_000)
        request.signal.addEventListener("abort", cancel, { once: true })
        if (request.signal.aborted) cancel()
        const open = async () => {
          if (finished) return
          try {
            const response = await dial(new Request(request, { signal: controller.signal }))
            const socket = response.webSocket
            if (finished || response.status !== 101 || !socket) {
              if (socket) {
                socket.accept()
                socket.close(1000)
              }
              if (finished) return
              throw new Error("SSH tunnel connection failed")
            }
            const connected = workerSessionSocket(socket)
            if (finished) {
              connected.close()
              return
            }
            finished = true
            cleanup()
            resolve(connected)
          } catch (error) {
            if (finished) return
            finished = true
            cleanup()
            controller.abort()
            reject(error)
          }
        }
        void open()
      })
    },
    async accept(_c, ready) {
      const pair = platform.pair()
      ready(workerSessionSocket(pair[1]))
      return platform.response(pair[0])
    },
  }
}

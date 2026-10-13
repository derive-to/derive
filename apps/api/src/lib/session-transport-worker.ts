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
      const response = await dial(request)
      if (response.status !== 101 || !response.webSocket)
        throw new Error("SSH tunnel connection failed")
      return workerSessionSocket(response.webSocket)
    },
    async accept(_c, ready) {
      const pair = platform.pair()
      ready(workerSessionSocket(pair[1]))
      return platform.response(pair[0])
    },
  }
}

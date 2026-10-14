import { IncomingMessage } from "node:http"
import { upgradeWebSocket } from "@hono/node-server"
import type { Context } from "hono"
import WebSocket from "ws"
import {
  bufferedSessionSocket,
  SESSION_FRAME_LIMIT,
  type SessionTransport,
} from "./session-transport"

const requestSocket = (c?: Context) => {
  const incoming: unknown = c?.env.incoming
  return incoming instanceof IncomingMessage ? incoming.socket : null
}

export function nodeSessionSocket(ws: WebSocket) {
  const buffered = bufferedSessionSocket(
    (data) =>
      new Promise((resolve, reject) => {
        if (
          ws.readyState !== WebSocket.OPEN ||
          ws.bufferedAmount + data.byteLength > SESSION_FRAME_LIMIT
        ) {
          reject(new Error("SSH tunnel unavailable"))
          return
        }
        ws.send(data, { binary: true }, (error) => (error ? reject(error) : resolve()))
      }),
    () => {
      clearInterval(ping)
      ws.terminate()
    },
  )
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping()
  }, 20_000)
  ws.on("message", (data, binary) => {
    if (!binary) buffered.message("")
    else if (data instanceof ArrayBuffer) buffered.message(new Uint8Array(data))
    else if (Array.isArray(data)) buffered.message(new Uint8Array(Buffer.concat(data)))
    else buffered.message(new Uint8Array(data))
  })
  ws.on("close", buffered.close)
  ws.on("error", buffered.close)
  return buffered.socket
}

export const nodeSessionTransport: SessionTransport = {
  watchDisconnect(c, close) {
    const downstream = requestSocket(c)
    downstream?.once("close", close)
    downstream?.once("end", close)
    if (downstream?.destroyed || downstream?.readableEnded) close()
    return () => {
      downstream?.off("close", close)
      downstream?.off("end", close)
    }
  },
  async connect(request, c) {
    const downstream = requestSocket(c)
    if (request.signal.aborted || downstream?.destroyed || downstream?.readableEnded)
      throw new Error("SSH tunnel connection canceled")
    const url = new URL(request.url)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: Object.fromEntries(request.headers),
        followRedirects: false,
        perMessageDeflate: false,
        handshakeTimeout: 15_000,
        maxPayload: SESSION_FRAME_LIMIT,
      })
      const socket = nodeSessionSocket(ws)
      const cleanup = () => {
        request.signal.removeEventListener("abort", abort)
        downstream?.off("close", abort)
        downstream?.off("end", abort)
      }
      const abort = () => {
        cleanup()
        socket.close()
        reject(new Error("SSH tunnel connection canceled"))
      }
      const fail = () => {
        cleanup()
        reject(new Error("SSH tunnel connection failed"))
      }
      request.signal.addEventListener("abort", abort, { once: true })
      downstream?.once("close", abort)
      downstream?.once("end", abort)
      ws.once("error", fail)
      ws.once("close", fail)
      ws.once("open", () => {
        cleanup()
        resolve(socket)
      })
    })
  },
  async accept(c, ready, failed) {
    const downstream = requestSocket(c)
    const cleanup = () => {
      clearTimeout(timeout)
      downstream?.off("close", abort)
      downstream?.off("end", abort)
    }
    const abort = () => {
      cleanup()
      failed()
    }
    const timeout = setTimeout(abort, 15_000)
    downstream?.once("close", abort)
    downstream?.once("end", abort)
    if (downstream?.destroyed || downstream?.readableEnded) {
      abort()
      return new Response(null, { status: 400 })
    }
    const result = await upgradeWebSocket(
      () => ({
        onOpen(_event, socket) {
          cleanup()
          if (socket.raw instanceof WebSocket) ready(nodeSessionSocket(socket.raw))
          else abort()
        },
        onError: abort,
      }),
      { onError: abort },
    )(c, async () => {})
    if (!(result instanceof Response) || result.status >= 400) {
      abort()
      return new Response(null, { status: 400 })
    }
    return result
  },
}

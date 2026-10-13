import { env } from "cloudflare:test"
import type { WebSocket as EdgeSocket } from "@cloudflare/workers-types"
import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import { relaySession } from "../../src/lib/session-transport"
import { workerSessionTransport } from "../../src/lib/session-transport-worker"

declare const WebSocketPair: typeof import("@cloudflare/workers-types").WebSocketPair

const message = (socket: EdgeSocket) =>
  new Promise<string | ArrayBuffer>((resolve) =>
    socket.addEventListener("message", (event) => resolve(event.data), { once: true }),
  )
const closed = (socket: EdgeSocket) =>
  new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }))

describe("SSH relay in workerd", () => {
  it("keeps the native fetch upgrade alive after caller cancellation and the handshake window", async () => {
    const transport = workerSessionTransport({
      dial: (request) => env.SSH_PROVIDER.fetch(request),
      pair: () => new WebSocketPair(),
      response(webSocket) {
        const init = { status: 101, webSocket }
        return new Response(null, init)
      },
    })
    const controller = new AbortController()
    const socket = await transport.connect(
      new Request("https://ortam.test/ssh", {
        headers: { Upgrade: "websocket" },
        signal: controller.signal,
      }),
    )
    const echoed = new Promise<Uint8Array | string>((resolve, reject) => {
      socket.listen({ message: resolve, close: () => reject(new Error("upgraded tunnel closed")) })
    })
    void echoed.catch(() => {})
    try {
      controller.abort()
      await new Promise((resolve) => setTimeout(resolve, 16_000))
      await socket.send(new Uint8Array([0, 255, 128]))
      expect(await echoed).toEqual(new Uint8Array([0, 255, 128]))
    } finally {
      socket.close()
    }
  }, 20_000)

  it("runs binary traffic through actual upgraded sockets and preserves provider headers", async () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers")
    const upstream = new WebSocketPair()
    upstream[1].accept()
    let dialed: Request | undefined
    const transport = workerSessionTransport({
      async dial(request) {
        dialed = request
        return { status: 101, webSocket: upstream[0] }
      },
      pair: () => new WebSocketPair(),
      response(webSocket) {
        const init = { status: 101, webSocket }
        return new Response(null, init)
      },
    })
    const app = new Hono()
    let close = () => {}
    app.get("/ssh", async (c) => {
      const socket = await transport.connect(
        new Request("https://ortam.test/v1/sandboxes/owned/ssh-tunnel", {
          headers: { Authorization: "Bearer fixture-key", "X-Ortam-Integration-Subject": "agent" },
        }),
      )
      upstream[1].send(new TextEncoder().encode("SSH-2.0-fixture\r\n"))
      const relay = relaySession(socket, async () => true, Date.now() + 60_000)
      close = relay.close
      return transport.accept(c, relay.ready, relay.close)
    })
    const response = await app.request("/ssh", { headers: { Upgrade: "websocket" } })
    expect(response.status).toBe(101)
    if (!("webSocket" in response) || !response.webSocket) throw new Error("missing upgrade socket")
    const client = response.webSocket as EdgeSocket
    const banner = message(client)
    client.accept()
    try {
      expect(new TextDecoder().decode((await banner) as ArrayBuffer)).toBe("SSH-2.0-fixture\r\n")
      expect(dialed?.headers.get("Authorization")).toBe("Bearer fixture-key")
      expect(dialed?.headers.get("X-Ortam-Integration-Subject")).toBe("agent")
      const bytes = new Uint8Array([0, 1, 255, 128, 13, 10])
      const received = message(upstream[1])
      client.send(bytes)
      expect(new Uint8Array((await received) as ArrayBuffer)).toEqual(bytes)
      const echoed = message(client)
      upstream[1].send(bytes)
      expect(new Uint8Array((await echoed) as ArrayBuffer)).toEqual(bytes)
      const clientClosed = closed(client)
      const upstreamClosed = closed(upstream[1])
      client.send("invalid text")
      await Promise.all([clientClosed, upstreamClosed])
    } finally {
      close()
      client.close()
      upstream[1].close()
    }
  })
})

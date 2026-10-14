import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"
import WebSocket, { WebSocketServer } from "ws"
import {
  bufferedSessionSocket,
  relaySession,
  SESSION_FRAME_LIMIT,
} from "../src/lib/session-transport"
import { nodeSessionTransport } from "../src/lib/session-transport-node"
import {
  type WorkerSessionSocket,
  workerSessionTransport,
} from "../src/lib/session-transport-worker"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.useRealTimers()
})

async function fixture() {
  const peer = new WebSocketServer({ port: 0, host: "127.0.0.1", maxPayload: SESSION_FRAME_LIMIT })
  cleanups.push(() => {
    for (const ws of peer.clients) ws.terminate()
    peer.close()
  })
  await once(peer, "listening")
  const peerPort = (peer.address() as AddressInfo).port
  const app = new Hono()
  let allowed = true
  const headers: string[] = []
  peer.on("connection", (ws, request) => {
    headers.push(
      String(request.headers.authorization),
      String(request.headers["x-ortam-integration-subject"]),
    )
    ws.send(Buffer.from("SSH-2.0-fixture\r\n"))
    ws.on("message", (data, binary) => ws.send(data, { binary }))
  })
  app.get("/ssh", async (c) => {
    const upstream = await nodeSessionTransport.connect(
      new Request(`http://127.0.0.1:${peerPort}/v1/sandboxes/owned/ssh-tunnel`, {
        headers: { Authorization: "Bearer fixture-key", "X-Ortam-Integration-Subject": "agent" },
      }),
    )
    const relay = relaySession(upstream, async () => allowed, Date.now() + 60_000)
    cleanups.push(relay.close)
    return nodeSessionTransport.accept(c, relay.ready, relay.close)
  })
  const sockets = new WebSocketServer({ noServer: true, maxPayload: SESSION_FRAME_LIMIT })
  const server = serve({
    fetch: app.fetch,
    port: 0,
    hostname: "127.0.0.1",
    websocket: { server: sockets },
  })
  cleanups.push(() => {
    for (const ws of sockets.clients) ws.terminate()
    sockets.close()
    server.close()
  })
  if (!server.listening) await once(server, "listening")
  const port = (server.address() as AddressInfo).port
  const client = new WebSocket(`ws://127.0.0.1:${port}/ssh`)
  const banner = once(client, "message")
  cleanups.push(() => client.terminate())
  await once(client, "open")
  return {
    client,
    banner,
    headers,
    revoke: () => {
      allowed = false
    },
    peer,
  }
}

describe("SSH binary relay", () => {
  it("upgrades through Hono's actual Node server, preserves the early banner and binary bytes", async () => {
    const { client, banner, headers } = await fixture()
    const [first, binary] = await banner
    expect(binary).toBe(true)
    expect(String(first)).toBe("SSH-2.0-fixture\r\n")
    expect(headers).toEqual(["Bearer fixture-key", "agent"])
    const bytes = Buffer.alloc(160_000)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
    const messages: Buffer[] = []
    const complete = new Promise<void>((resolve) => {
      let length = 0
      client.on("message", (data, isBinary) => {
        expect(isBinary).toBe(true)
        if (!Buffer.isBuffer(data)) throw new Error("unexpected frame")
        messages.push(data)
        length += data.length
        if (length === bytes.length) resolve()
      })
    })
    for (let offset = 0; offset < bytes.length; offset += 32_768)
      client.send(bytes.subarray(offset, offset + 32_768))
    await complete
    expect(Buffer.concat(messages)).toEqual(bytes)
  })

  it("closes both peers when session access is revoked", async () => {
    const { client, banner, revoke, peer } = await fixture()
    await banner
    const closed = once(client, "close")
    revoke()
    await closed
    await vi.waitFor(() => expect(peer.clients.size).toBe(0))
  }, 10_000)

  it("rejects text frames and closes upstream", async () => {
    const { client, banner, peer } = await fixture()
    await banner
    const closed = once(client, "close")
    client.send("not SSH bytes")
    await closed
    await vi.waitFor(() => expect(peer.clients.size).toBe(0))
  })

  it("refuses a failed upstream handshake without leaving a socket alive", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1", verifyClient: () => false })
    cleanups.push(() => server.close())
    await once(server, "listening")
    await expect(
      nodeSessionTransport.connect(
        new Request(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ssh`),
      ),
    ).rejects.toThrow("SSH tunnel connection failed")
  })

  it("honors cancellation before and during an upstream handshake", async () => {
    const waiting = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      verifyClient: (_info, _done) => {},
    })
    cleanups.push(() => waiting.close())
    await once(waiting, "listening")
    const url = `http://127.0.0.1:${(waiting.address() as AddressInfo).port}/ssh`
    await expect(
      nodeSessionTransport.connect(new Request(url, { signal: AbortSignal.abort() })),
    ).rejects.toThrow("canceled")
    const abort = new AbortController()
    const connecting = nodeSessionTransport.connect(new Request(url, { signal: abort.signal }))
    abort.abort()
    await expect(connecting).rejects.toThrow("canceled")
  })

  it("ignores empty frames, bounds tiny queued frames, and fails closed on a stalled permission check", async () => {
    vi.useFakeTimers()
    let upClosed = 0
    let downClosed = 0
    const up = bufferedSessionSocket(
      async () => {},
      () => {
        upClosed++
      },
    )
    const down = bufferedSessionSocket(
      () => new Promise(() => {}),
      () => {
        downClosed++
      },
    )
    const relay = relaySession(up.socket, () => new Promise(() => {}), Date.now() + 60_000)
    relay.ready(down.socket)
    for (let i = 0; i < 10_000; i++) up.message(new Uint8Array(0))
    expect([upClosed, downClosed]).toEqual([0, 0])
    await vi.advanceTimersByTimeAsync(20_000)
    expect([upClosed, downClosed]).toEqual([1, 1])
    let bounded = 0
    const banner = bufferedSessionSocket(
      async () => {},
      () => {
        bounded++
      },
    )
    for (let i = 0; i < 257; i++) banner.message(new Uint8Array(1))
    expect(bounded).toBe(1)
    let queueClosed = 0
    const source = bufferedSessionSocket(
      async () => {},
      () => {
        queueClosed++
      },
    )
    const sink = bufferedSessionSocket(
      () => new Promise(() => {}),
      () => {},
    )
    const queued = relaySession(source.socket, async () => true, Date.now() + 60_000)
    queued.ready(sink.socket)
    for (let i = 0; i < 257; i++) source.message(new Uint8Array(1))
    expect(queueClosed).toBe(1)
  })

  it("bounds an early banner, queued writes, and a stalled write", async () => {
    vi.useFakeTimers()
    let earlyClosed = 0
    const early = bufferedSessionSocket(
      async () => {},
      () => {
        earlyClosed++
      },
    )
    early.message(new Uint8Array(SESSION_FRAME_LIMIT + 1))
    expect(earlyClosed).toBe(1)
    let upClosed = 0
    let downClosed = 0
    const up = bufferedSessionSocket(
      async () => {},
      () => {
        upClosed++
      },
    )
    const down = bufferedSessionSocket(
      () => new Promise(() => {}),
      () => {
        downClosed++
      },
    )
    const relay = relaySession(up.socket, async () => true, Date.now() + 60_000)
    relay.ready(down.socket)
    up.message(new Uint8Array(32_768))
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(30_000)
    expect([upClosed, downClosed]).toEqual([1, 1])
    const source = bufferedSessionSocket(
      async () => {},
      () => {},
    )
    const target = bufferedSessionSocket(
      () => new Promise(() => {}),
      () => {},
    )
    const bounded = relaySession(source.socket, async () => true, Date.now() + 60_000)
    bounded.ready(target.socket)
    for (let i = 0; i < 33; i++) source.message(new Uint8Array(32_768))
    const ended = vi.fn()
    source.socket.listen({ message() {}, close: ended })
    expect(ended).toHaveBeenCalledOnce()
  })
})

describe("Worker SSH handshake lifetime", () => {
  const fixture = (
    dial: (request: Request) => Promise<{ status: number; webSocket?: WorkerSessionSocket }>,
  ) => {
    const upstream = { accept: vi.fn(), send: vi.fn(), close: vi.fn(), addEventListener: vi.fn() }
    return {
      upstream,
      transport: workerSessionTransport({
        dial,
        pair: () => ({ 0: upstream, 1: upstream }),
        response: () => new Response(),
      }),
    }
  }

  it("bounds a stalled dial even if the platform does not settle on abort", async () => {
    vi.useFakeTimers()
    const { transport } = fixture(() => new Promise(() => {}))
    const connecting = transport.connect(new Request("https://ortam.test/ssh"))
    const rejected = expect(connecting).rejects.toThrow("SSH tunnel connection")
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
  })

  it("detaches caller cancellation and handshake timeout after admitting the socket", async () => {
    vi.useFakeTimers()
    let dialed: Request | undefined
    const { upstream, transport } = fixture(async (request) => {
      dialed = request
      return { status: 101, webSocket: upstream }
    })
    const controller = new AbortController()
    const socket = await transport.connect(
      new Request("https://ortam.test/ssh", { signal: controller.signal }),
    )
    controller.abort()
    await vi.advanceTimersByTimeAsync(16_000)
    expect(dialed?.signal.aborted).toBe(false)
    await socket.send(new Uint8Array([0, 255]))
    expect(upstream.send).toHaveBeenCalledWith(new Uint8Array([0, 255]))
    socket.close()
  })

  it("rejects a canceled handshake and closes an upgrade returned after cancellation", async () => {
    let finish: ((response: { status: number; webSocket: WorkerSessionSocket }) => void) | undefined
    const { upstream, transport } = fixture(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const controller = new AbortController()
    const connecting = transport.connect(
      new Request("https://ortam.test/ssh", { signal: controller.signal }),
    )
    const rejected = expect(connecting).rejects.toThrow("SSH tunnel connection canceled")
    controller.abort()
    await rejected
    finish?.({ status: 101, webSocket: upstream })
    await Promise.resolve()
    expect(upstream.close).toHaveBeenCalledWith(1000)
  })

  it("closes an upstream when cancellation fires while accepting the upgrade", async () => {
    const controller = new AbortController()
    const { upstream, transport } = fixture(async () => ({ status: 101, webSocket: upstream }))
    upstream.accept.mockImplementation(() => controller.abort())
    await expect(
      transport.connect(new Request("https://ortam.test/ssh", { signal: controller.signal })),
    ).rejects.toThrow("SSH tunnel connection canceled")
    expect(upstream.close).toHaveBeenCalledWith(1000)
  })

  it("does not dial a pre-canceled request and closes a socket on an invalid upgrade", async () => {
    const controller = new AbortController()
    controller.abort()
    const dial = vi.fn(async () => ({ status: 200, webSocket: upstream }))
    const { upstream, transport } = fixture(dial)
    await expect(
      transport.connect(new Request("https://ortam.test/ssh", { signal: controller.signal })),
    ).rejects.toThrow("SSH tunnel connection canceled")
    expect(dial).not.toHaveBeenCalled()
    await expect(transport.connect(new Request("https://ortam.test/ssh"))).rejects.toThrow(
      "SSH tunnel connection failed",
    )
    expect(upstream.close).toHaveBeenCalledWith(1000)
  })
})

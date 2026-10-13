import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { SESSION_TMUX } from "./conversation-format.js"

const MAX_FRAME = 1_048_576
const MAX_CHUNK = 32_768
const sshKey = (value, certificate = false) =>
  typeof value === "string" &&
  !/[\r\n]/.test(value) &&
  (certificate
    ? /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))-cert-v01@openssh\.com [A-Za-z0-9+/]+={0,2}(?: [^\r\n]+)?$/
    : /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}(?: [^\r\n]+)?$/
  ).test(value)

export async function sessionShell(access, { key, id, openSshTunnel }) {
  const tmux = access.tmux_session ?? SESSION_TMUX
  if (!/^[A-Za-z0-9_-]+$/.test(tmux) || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(access.user ?? ""))
    throw new Error("invalid SSH session details")
  const relay = access.transport === "websocket"
  if (access.transport && !relay && access.transport !== "direct")
    throw new Error("unsupported SSH session transport")
  if (access.host_key && !sshKey(access.host_key)) throw new Error("invalid SSH host key")
  if (relay) {
    if (
      !access.host_key ||
      access.user !== "ortam" ||
      !sshKey(access.certificate, true) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(access.certificate_expires_at ?? "") ||
      !(Date.parse(access.certificate_expires_at) > Date.now()) ||
      !Number.isFinite(Date.parse(access.claim)) ||
      access.tunnel_path !== `/v1/jobs/${id}/ssh` ||
      typeof openSshTunnel !== "function"
    )
      throw new Error("invalid or expired SSH certificate session")
  } else if (
    !/^[A-Za-z0-9:.-]+$/.test(access.host ?? "") ||
    !Number.isInteger(access.port) ||
    access.port < 1 ||
    access.port > 65535
  ) {
    throw new Error("invalid SSH address")
  }

  const dir = mkdtempSync(join(tmpdir(), "derive-session-"))
  const knownHosts = join(dir, "known_hosts")
  let child
  let listener
  let socket
  let websocket
  let failure
  let closed = false
  let disconnectTimer
  const close = () => {
    if (closed) return
    closed = true
    clearTimeout(disconnectTimer)
    socket?.destroy()
    websocket?.terminate()
    listener?.close()
    rmSync(dir, { recursive: true, force: true })
  }
  const fail = (error) => {
    if (closed) return
    failure ??= error
    child?.kill("SIGTERM")
    close()
  }
  try {
    if (access.host_key)
      writeFileSync(knownHosts, `derive-session ${access.host_key}\n`, { mode: 0o600 })
    const ssh = [
      ...(access.host_key ? ["-F", "/dev/null"] : []),
      "-i",
      resolve(key),
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      ...(access.host_key
        ? [
            "-o",
            "UserKnownHostsFile=known_hosts",
            "-o",
            "GlobalKnownHostsFile=/dev/null",
            "-o",
            "HostKeyAlias=derive-session",
          ]
        : []),
      "-o",
      `StrictHostKeyChecking=${access.host_key ? "yes" : "accept-new"}`,
      "-o",
      "ServerAliveInterval=30",
    ]
    let host = access.host
    let port = access.port
    if (relay) {
      const certificate = join(dir, "certificate.pub")
      writeFileSync(certificate, `${access.certificate}\n`, { mode: 0o600 })
      ssh.push("-o", "CertificateFile=certificate.pub")
      listener = createServer((incoming) => {
        if (socket || closed) {
          incoming.destroy()
          return
        }
        socket = incoming
        socket.pause()
        socket.on("error", fail)
        socket.on("close", () => {
          websocket?.terminate()
          listener?.close()
        })
        try {
          websocket = openSshTunnel(access.tunnel_path, access.claim)
        } catch (error) {
          fail(error)
          return
        }
        websocket.on("error", () => fail(new Error("SSH tunnel connection failed")))
        websocket.on("open", () => socket.resume())
        websocket.on("message", (data, binary) => {
          if (
            !binary ||
            data.length > MAX_FRAME ||
            socket.writableLength + data.length > MAX_FRAME
          ) {
            fail(new Error("SSH tunnel received an invalid frame"))
            return
          }
          if (!socket.write(data)) websocket.pause()
        })
        socket.on("drain", () => websocket.resume())
        socket.on("data", (data) => {
          socket.pause()
          let offset = 0
          const send = (error) => {
            if (error) {
              fail(new Error("SSH tunnel send failed"))
              return
            }
            if (closed) return
            if (offset >= data.length) {
              socket.resume()
              return
            }
            const next = data.subarray(offset, offset + MAX_CHUNK)
            offset += next.length
            websocket.send(next, { binary: true }, send)
          }
          send()
        })
        websocket.on("close", () => {
          socket.end()
          listener.close()
          disconnectTimer = setTimeout(() => child?.kill("SIGTERM"), 2_000)
          disconnectTimer.unref()
        })
      })
      await new Promise((resolve, reject) => {
        listener.once("error", reject)
        listener.listen(0, "127.0.0.1", resolve)
      })
      listener.on("error", fail)
      host = "127.0.0.1"
      port = listener.address().port
    }
    ssh.push("-p", String(port), `${access.user}@${host}`)
    return {
      tmux,
      async run(args, command) {
        const signal = (name) => child?.kill(name)
        let interrupted = false
        const interrupt = () => {
          interrupted = true
          signal("SIGINT")
        }
        const terminate = () => signal("SIGTERM")
        try {
          if (failure) throw failure
          const result = await new Promise((resolve, reject) => {
            child = spawn("ssh", [...args, ...ssh, ...(command ? [command] : [])], {
              stdio: "inherit",
              ...(access.host_key ? { cwd: dir } : {}),
            })
            child.once("error", reject)
            child.once("exit", (code, stopped) => {
              if (failure) reject(failure)
              else resolve(interrupted || stopped === "SIGINT" ? 130 : (code ?? 1))
            })
            process.on("SIGINT", interrupt)
            process.on("SIGTERM", terminate)
          })
          return result
        } finally {
          process.off("SIGINT", interrupt)
          process.off("SIGTERM", terminate)
          close()
        }
      },
      close,
    }
  } catch (error) {
    close()
    throw error
  }
}

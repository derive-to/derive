import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer as httpServer } from "node:http"
import { connect, createServer as tcpServer } from "node:net"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import WebSocket, { WebSocketServer } from "ws"
import { sessionShell } from "../../src/session-shell.js"

const dir = mkdtempSync(join(tmpdir(), "derive-native-ssh-"))
const username = userInfo().username
const sshdPath = process.env.DERIVE_NATIVE_SSHD ?? "/usr/sbin/sshd"
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
const availablePort = async () => {
  const server = tcpServer()
  await listen(server)
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const keys = ["client", "other-client", "ca", "other-ca", "host", "other-host"]
const sign = (ca, validity = "-1m:+5m") => {
  const result = spawnSync("ssh-keygen", [
    "-q",
    "-s",
    join(dir, ca),
    "-I",
    "derive-native-qualification",
    "-n",
    username,
    "-V",
    validity,
    join(dir, "client.pub"),
  ])
  assert.equal(result.status, 0, result.stderr.toString())
  const certificate = readFileSync(join(dir, "client-cert.pub"), "utf8").trim()
  rmSync(join(dir, "client-cert.pub"))
  return certificate
}
let sshd
let wsServer
let http
const peers = new Set()
let sshdLog = ""
let tunnelCount = 0
let frameCount = 0
const cleanup = async () => {
  for (const peer of peers) peer.terminate()
  if (wsServer) await new Promise((resolve) => wsServer.close(resolve))
  if (http) {
    http.closeAllConnections()
    await new Promise((resolve) => http.close(resolve))
  }
  if (sshd && sshd.exitCode === null) {
    const exited = new Promise((resolve) => sshd.once("exit", resolve))
    sshd.kill("SIGTERM")
    await exited
  }
  rmSync(dir, { recursive: true, force: true })
}
try {
  assert.ok(existsSync(sshdPath), `native qualification requires sshd at ${sshdPath}`)
  for (const name of keys) {
    const result = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, name)])
    assert.equal(result.status, 0, result.stderr.toString())
  }
  const port = await availablePort()
  const config = join(dir, "sshd_config")
  writeFileSync(
    config,
    `Port ${port}
ListenAddress 127.0.0.1
HostKey ${join(dir, "host")}
PidFile ${join(dir, "sshd.pid")}
TrustedUserCAKeys ${join(dir, "ca.pub")}
AuthorizedKeysFile none
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
AllowUsers ${username}
AllowTcpForwarding yes
LogLevel VERBOSE
`,
  )
  const configured = spawnSync(sshdPath, ["-T", "-f", config], { encoding: "utf8" })
  assert.equal(configured.status, 0, configured.stderr)
  if (configured.stdout.includes("persourcepenalties"))
    writeFileSync(config, `${readFileSync(config, "utf8")}PerSourcePenalties no\n`)
  sshd = spawn(sshdPath, ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "pipe"] })
  sshd.stderr.on("data", (data) => {
    sshdLog += data
  })
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`sshd did not listen: ${sshdLog}`)), 5_000)
    const onData = () => {
      if (sshdLog.includes("Server listening")) {
        clearTimeout(deadline)
        sshd.stderr.off("data", onData)
        resolve()
      }
    }
    sshd.stderr.on("data", onData)
    sshd.once("error", reject)
    sshd.once("exit", (code) => reject(new Error(`sshd exited ${code}: ${sshdLog}`)))
    onData()
  })
  wsServer = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    perMessageDeflate: false,
    maxPayload: 1_048_576,
  })
  await new Promise((resolve) => wsServer.once("listening", resolve))
  wsServer.on("connection", (ws) => {
    peers.add(ws)
    tunnelCount++
    const socket = connect(port, "127.0.0.1")
    socket.pause()
    socket.once("connect", () => socket.resume())
    socket.on("data", (data) => {
      socket.pause()
      ws.send(data, { binary: true }, (error) => {
        if (error) socket.destroy()
        else socket.resume()
      })
    })
    ws.on("message", (data, binary) => {
      assert.ok(binary)
      frameCount++
      if (!socket.write(data)) ws.pause()
    })
    socket.on("drain", () => ws.resume())
    socket.on("error", () => ws.terminate())
    socket.on("close", () => ws.close())
    ws.on("close", () => {
      peers.delete(ws)
      socket.destroy()
    })
    ws.on("error", () => socket.destroy())
  })
  const certificate = sign("ca")
  const access = {
    transport: "websocket",
    user: "ortam",
    host_key: readFileSync(join(dir, "host.pub"), "utf8").trim(),
    certificate,
    certificate_expires_at: new Date(Date.now() + 300_000).toISOString(),
    tunnel_path: "/v1/jobs/job_native/ssh",
    claim: "2026-01-01T00:00:00.000Z",
    tmux_session: "derive",
  }
  const makeShell = async (overrides = {}, key = "client") => {
    const before = new Set(readdirSync(tmpdir()))
    const shell = await sessionShell(
      { ...access, ...overrides },
      {
        key: join(dir, key),
        id: "job_native",
        openSshTunnel: (path, claim) => {
          assert.equal(path, access.tunnel_path)
          assert.equal(claim, access.claim)
          return new WebSocket(`ws://127.0.0.1:${wsServer.address().port}`, {
            maxPayload: 1_048_576,
            perMessageDeflate: false,
          })
        },
      },
    )
    const files = readdirSync(tmpdir())
      .filter((file) => file.startsWith("derive-session-") && !before.has(file))
      .map((file) => join(tmpdir(), file))
    assert.equal(files.length, 1, "one private attach directory")
    return {
      shell,
      assertClean: () => {
        for (const file of files) assert.equal(existsSync(file), false, `${file} cleaned`)
      },
    }
  }
  const first = await makeShell()
  const marker = join(dir, "admitted")
  assert.equal(
    await first.shell.run(["-l", username], `printf native-session > ${quote(marker)}`),
    0,
  )
  assert.equal(readFileSync(marker, "utf8"), "native-session")
  first.assertClean()
  assert.match(sshdLog, /Accepted publickey/)
  process.stdout.write(
    "PASS native certificate admission, remote command and private-file cleanup\n",
  )

  const persistentHosts = join(dir, "persistent_known_hosts")
  const directCertificate = join(dir, "direct-certificate.pub")
  writeFileSync(directCertificate, `${certificate}\n`, { mode: 0o600 })
  writeFileSync(persistentHosts, `[127.0.0.1]:${port} ${access.host_key}\n`, { mode: 0o600 })
  const directConfig = join(dir, "direct_ssh_config")
  writeFileSync(
    directConfig,
    `Host *\n  UserKnownHostsFile ${persistentHosts}\n  CertificateFile ${directCertificate}\n`,
    { mode: 0o600 },
  )
  const directOptions = ["-F", directConfig]
  const directAccess = {
    transport: "direct",
    host: "127.0.0.1",
    port,
    user: username,
    host_key: null,
  }
  const direct = await makeShell(directAccess)
  assert.equal(await direct.shell.run(directOptions, "true"), 0)
  direct.assertClean()
  writeFileSync(
    persistentHosts,
    `[127.0.0.1]:${port} ${readFileSync(join(dir, "other-host.pub"), "utf8").trim()}\n`,
  )
  const changedDirect = await makeShell(directAccess)
  assert.equal(await changedDirect.shell.run(directOptions, "true"), 255)
  changedDirect.assertClean()
  process.stdout.write(
    "PASS native direct SSH retains persistent host trust and rejects a changed key\n",
  )

  http = httpServer((_request, response) => response.end("native-forward-body"))
  await listen(http)
  const forwardPort = await availablePort()
  const shortCertificate = sign("ca", "-1m:+3s")
  const expiresBy = Date.now() + 4_000
  const forwarded = await makeShell({ certificate: shortCertificate })
  const outcome = forwarded.shell.run([
    "-l",
    username,
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    `${forwardPort}:127.0.0.1:${http.address().port}`,
  ])
  let completed = false
  outcome.then(
    () => {
      completed = true
    },
    () => {
      completed = true
    },
  )
  const deadline = Date.now() + 5_000
  let body
  while (Date.now() < deadline && !completed) {
    try {
      body = await (
        await fetch(`http://127.0.0.1:${forwardPort}`, { signal: AbortSignal.timeout(500) })
      ).text()
      break
    } catch {
      await delay(25)
    }
  }
  assert.equal(body, "native-forward-body")
  await delay(Math.max(0, expiresBy - Date.now()))
  assert.equal(
    await (
      await fetch(`http://127.0.0.1:${forwardPort}`, { signal: AbortSignal.timeout(2_000) })
    ).text(),
    "native-forward-body",
  )
  process.emit("SIGINT")
  assert.equal(await outcome, 130)
  assert.equal(body, "native-forward-body")
  forwarded.assertClean()
  process.stdout.write(
    "PASS native HTTP forwarding survives certificate expiry; interrupt cleans the relay\n",
  )

  const badHost = await makeShell({
    host_key: readFileSync(join(dir, "other-host.pub"), "utf8").trim(),
  })
  assert.equal(await badHost.shell.run(["-l", username], "true"), 255)
  badHost.assertClean()
  process.stdout.write("PASS native host-key mismatch rejection\n")

  for (const [label, overrides, key] of [
    ["mismatched private key", {}, "other-client"],
    ["untrusted certificate signer", { certificate: sign("other-ca") }, "client"],
    [
      "expired certificate with future API expiry",
      { certificate: sign("ca", "-5m:-1m") },
      "client",
    ],
    ["malformed certificate", { certificate: "ssh-ed25519-cert-v01@openssh.com AAAA" }, "client"],
  ]) {
    const candidate = await makeShell(overrides, key)
    assert.equal(await candidate.shell.run(["-l", username], "true"), 255, label)
    candidate.assertClean()
    process.stdout.write(`PASS native ${label} rejection and cleanup\n`)
  }
  assert.match(sshdLog, /Certificate invalid: expired/)
  assert.ok(tunnelCount >= 7)
  assert.ok(frameCount > 0)
  process.stdout.write(
    `Qualified local OpenSSH through ${tunnelCount} WebSocket tunnels; no live Ortam or tmux session exercised.\n`,
  )
} finally {
  await cleanup()
}

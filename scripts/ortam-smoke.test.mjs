import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { runOrtamSmoke } from "./ortam-smoke.mjs"

const sandboxId = `sbx_${"a".repeat(26)}`
const processId = `prc_${"b".repeat(26)}`
const operationId = (letter) => `op_${letter.repeat(26)}`

// A public-API peer with real HTTP disconnects. It tests the controller contract,
// not VM provision, filesystem checkpoint durability or Hetzner cleanup.
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "derive-ortam-smoke-"))
  const statePath = join(directory, "receipt.json")
  const calls = []
  const accepted = new Map()
  let sandboxState = "provisioning"
  let output = ""
  let starts = 0
  let creates = 0
  let dropped = false
  let organization = "test-organization"
  const server = createServer(async (req, res) => {
    let text = ""
    for await (const chunk of req) text += chunk
    const body = text ? JSON.parse(text) : undefined
    const path = req.url.replace(/^\/v1/, "")
    calls.push({ path, method: req.method, body, key: req.headers["idempotency-key"] })
    const reply = (value, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(value))
    }
    if (path === "/auth/token") {
      const claims = Buffer.from(JSON.stringify({ organization_id: organization })).toString(
        "base64url",
      )
      reply({ token: `test.${claims}.unsigned` })
      return
    }
    if (!req.headers.authorization?.startsWith("Bearer test.")) {
      reply({}, 401)
      return
    }
    const operation = (kind, state = "succeeded") => ({
      id: operationId(kind[0]),
      sandbox_id: sandboxId,
      kind,
      state,
    })
    const sandbox = () => ({ id: sandboxId, state: sandboxState, current_operation_id: null })
    if (req.method === "POST" && path === "/sandboxes") {
      assert.equal(body.auto_stop_after_seconds, 300)
      assert.equal(body.size, "small")
      if (!accepted.has(req.headers["idempotency-key"])) {
        creates++
        sandboxState = "ready"
        accepted.set(req.headers["idempotency-key"], {
          sandbox: sandbox(),
          operation: operation("create"),
        })
      }
      if (options.drop === "create" && !dropped) {
        dropped = true
        res.destroy()
        return
      }
      reply(accepted.get(req.headers["idempotency-key"]), 202)
    } else if (req.method === "POST" && path.endsWith("/processes")) {
      starts++
      assert.deepEqual(body.argv.slice(0, 2), ["/usr/bin/printf", "%s\\n"])
      assert.equal(body.timeout_seconds, 30)
      assert.equal(body.env, undefined)
      output = `${body.argv[2]}\n`
      if (options.onLaunch) {
        options.onLaunch()
        // The crash test kills the requesting process after the server accepted
        // work, before the caller can learn its process ID.
        return
      }
      if (options.drop === "process") {
        res.destroy()
        return
      }
      reply({ id: processId, status: "running" }, 201)
    } else if (path.includes(`/processes/${processId}`)) {
      reply({
        id: processId,
        status: "exited",
        exit_code: options.exitCode ?? 0,
        stdout: output,
        stderr: "",
        stdout_truncated: false,
        stderr_truncated: false,
      })
    } else if (req.method === "POST" && path.endsWith("/stop")) {
      accepted.set(req.headers["idempotency-key"], operation("stop"))
      sandboxState = "stopped"
      if (options.drop === "stop" && !dropped) {
        dropped = true
        res.destroy()
        return
      }
      reply(operation("stop"), 202)
    } else if (req.method === "DELETE") {
      if (req.headers["x-ortam-confirm-delete"] !== sandboxId) {
        reply({ code: "delete_confirmation_required" }, 422)
        return
      }
      accepted.set(req.headers["idempotency-key"], operation("delete"))
      sandboxState = "deleted"
      if (options.drop === "delete" && !dropped) {
        dropped = true
        res.destroy()
        return
      }
      reply(operation("delete"), 202)
    } else if (path.startsWith("/operations/")) {
      const kind = path.endsWith(operationId("c"))
        ? "create"
        : path.endsWith(operationId("s"))
          ? "stop"
          : "delete"
      reply(operation(kind, kind === options.failedOperation ? "failed" : "succeeded"))
    } else if (path === `/sandboxes/${sandboxId}`) {
      reply(sandbox())
    } else reply({ unexpected: path }, 404)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  const input = {
    statePath,
    apiKey: "test-only-key", // gitleaks:allow test HTTP peer only
    apiUrl: `http://127.0.0.1:${server.address().port}/v1`,
    pollMs: 0,
    probeMs: 5000,
    cleanupMs: 5000,
  }
  return {
    input,
    calls,
    accepted,
    statePath,
    starts: () => starts,
    creates: () => creates,
    organization: (value) => {
      organization = value
    },
  }
}

test("a check records its result and waits for stop and deletion; reopening does not create again", async (t) => {
  const f = await fixture(t)
  const result = await runOrtamSmoke(f.input)
  assert.equal(result.passed, true)
  assert.equal(result.cleanup_confirmed, true)
  assert.equal(result.stop_status, "succeeded")
  assert.equal(f.starts(), 1)
  assert.equal(f.creates(), 1)
  assert.deepEqual(await runOrtamSmoke(f.input), result)
  assert.equal(f.creates(), 1)
  const receipt = await readFile(f.statePath, "utf8")
  assert.ok(!receipt.includes(f.input.apiKey))
  assert.ok(!receipt.includes("unsigned"))
  assert.ok(
    f.calls.findIndex((c) => c.path.includes("/processes/")) <
      f.calls.findIndex((c) => c.method === "DELETE"),
  )
})

for (const drop of ["create", "stop", "delete"]) {
  test(`lost ${drop} response reuses the same request identity`, async (t) => {
    const f = await fixture(t, { drop })
    const result = await runOrtamSmoke(f.input)
    assert.equal(result.passed, true)
    assert.equal(f.creates(), 1)
    assert.equal(f.starts(), 1)
    const retries = f.calls.filter((c) => c.key?.endsWith(`-${drop}`))
    assert.equal(retries.length, 2)
    assert.equal(retries[0].key, retries[1].key)
    assert.deepEqual(retries[0].body, retries[1].body)
  })
}

test("a lost process response never repeats the command and still cleans up", async (t) => {
  const f = await fixture(t, { drop: "process" })
  const result = await runOrtamSmoke(f.input)
  assert.equal(result.passed, false)
  assert.equal(result.cleanup_confirmed, true)
  assert.match(result.error, /unknown/)
  assert.equal(f.starts(), 1)
})

test("a nonzero child exit is a failed check with confirmed cleanup", async (t) => {
  const f = await fixture(t, { exitCode: 7 })
  const result = await runOrtamSmoke(f.input)
  assert.equal(result.passed, false)
  assert.equal(result.result.exit_code, 7)
  assert.equal(result.cleanup_confirmed, true)
})

test("failed stop still deletes the disposable machine, without claiming the cycle passed", async (t) => {
  const f = await fixture(t, { failedOperation: "stop" })
  const result = await runOrtamSmoke(f.input)
  assert.equal(result.passed, false)
  assert.equal(result.stop_status, "failed")
  assert.equal(result.cleanup_confirmed, true)
})

test("failed deletion leaves a recoverable receipt and cannot report cleanup complete", async (t) => {
  const f = await fixture(t, { failedOperation: "delete" })
  await assert.rejects(runOrtamSmoke({ ...f.input, cleanupMs: 100 }), /Cleanup is unconfirmed/)
  const receipt = JSON.parse(await readFile(f.statePath, "utf8"))
  assert.equal(receipt.phase, "delete")
  assert.ok(receipt.delete_operation)
  assert.notEqual(receipt.cleanup_confirmed, true)
})

test("a hard crash after accepting the command recovers without starting it twice", async (t) => {
  let launched
  const launch = new Promise((resolve) => {
    launched = resolve
  })
  const f = await fixture(t, { onLaunch: () => launched() })
  const child = spawn(process.execPath, ["scripts/ortam-smoke.mjs", "--state", f.statePath], {
    env: { ...process.env, ORTAM_API_KEY: f.input.apiKey, ORTAM_API_URL: f.input.apiUrl },
    stdio: "ignore",
  })
  t.after(() => child.kill("SIGKILL"))
  await launch
  const exited = once(child, "exit")
  child.kill("SIGKILL")
  await exited
  assert.equal(JSON.parse(await readFile(f.statePath, "utf8")).phase, "launch")
  await assert.rejects(runOrtamSmoke(f.input), /locked/)
  // This test has proved that the old PID exited. A human follows the same
  // procedure for a lock left by SIGKILL or a machine restart.
  await rm(`${f.statePath}.lock`)
  const result = await runOrtamSmoke(f.input)
  assert.equal(result.passed, false)
  assert.equal(result.cleanup_confirmed, true)
  assert.equal(f.starts(), 1)
})

test("wrong organization, malformed receipt and simultaneous readers fail before creating resources", async (t) => {
  const f = await fixture(t)
  await runOrtamSmoke(f.input)
  f.organization("another-organization")
  await assert.rejects(runOrtamSmoke(f.input), /different Ortam/)
  assert.equal(f.creates(), 1)
  await writeFile(f.statePath, "{invalid")
  await assert.rejects(runOrtamSmoke(f.input), /Receipt cannot be read/)
  await writeFile(`${f.statePath}.lock`, "12345\n")
  await assert.rejects(runOrtamSmoke(f.input), /locked/)
  assert.equal(f.creates(), 1)
})

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { runOrtamSmoke } from "./ortam-smoke.mjs"

const uuid = (digit) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`
const sandboxId = uuid("a")
const executionId = uuid("b")
const operationId = { create: uuid("c"), launch: uuid("e"), stop: uuid("5"), delete: uuid("d") }

// An API peer with real HTTP disconnects. It tests the controller contract,
// not VM provision, filesystem checkpoint durability or Hetzner cleanup.
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "derive-ortam-smoke-"))
  const statePath = join(directory, "receipt.json")
  const calls = []
  const accepted = new Map()
  let phase = "stopped"
  let output = ""
  let starts = 0
  let creates = 0
  let dropped = false
  let visible = true
  const server = createServer(async (req, res) => {
    let text = ""
    for await (const chunk of req) text += chunk
    const body = text ? JSON.parse(text) : undefined
    const path = req.url.replace(/^\/v1/, "")
    const key = req.headers["idempotency-key"]
    calls.push({ path, method: req.method, body, key })
    const reply = (value, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(value))
    }
    if (req.headers.authorization !== "Bearer test-only-key") {
      reply({ code: "unauthorized" }, 401)
      return
    }
    if (req.method !== "GET" && !key) {
      reply({ code: "invalid_request", error: "Idempotency-Key is required" }, 400)
      return
    }
    // Lose the first response to this kind of request, after the work was accepted.
    const lost = (kind) => {
      if (options.drop !== kind || dropped) return false
      dropped = true
      res.destroy()
      return true
    }
    const operation = (kind, resource = sandboxId) => ({
      id: operationId[kind],
      kind: kind === "launch" ? "execute" : kind,
      resource_id: resource,
      state: kind === options.failedOperation ? "failed" : "completed",
      ...(kind === "stop" ? { result: { final_save: { state: "published" } } } : {}),
    })
    const sandbox = () => ({ id: sandboxId, name: "derive-smoke", phase })
    if (path === "/sandboxes?limit=1") reply([])
    else if (req.method === "POST" && path === "/sandboxes") {
      assert.deepEqual(Object.keys(body).sort(), ["name", "size"])
      assert.equal(body.size, "small")
      if (!accepted.has(key)) {
        creates++
        accepted.set(key, { operation: operation("create"), resource: sandbox() })
      }
      if (!lost("create")) reply(accepted.get(key), 201)
    } else if (!visible) reply({ code: "not_found" }, 404)
    else if (req.method === "POST" && path === `/sandboxes/${sandboxId}/executions`) {
      // The command arms its own power-off before printing: Ortam stops nothing itself.
      assert.match(body.argv[2], /^\(sleep 300; sudo poweroff\) .*&\nprintf '%s\\n' "\$1"$/)
      assert.equal(body.timeout_seconds, 30)
      assert.equal(body.env, undefined)
      if (!accepted.has(key)) {
        starts++
        phase = "running"
        output = `${body.argv[4]}\n`
        accepted.set(key, {
          operation: operation("launch", executionId),
          resource: { id: executionId },
        })
      }
      if (options.onLaunch) {
        options.onLaunch()
        // The crash test kills the requesting process after the server accepted
        // work, before the caller can learn its execution ID.
        options.onLaunch = undefined
        return
      }
      if (!lost("launch")) reply(accepted.get(key), 202)
      if (options.hideAfterLaunch) visible = false
    } else if (path === `/executions/${executionId}`)
      reply({
        id: executionId,
        sandbox_id: sandboxId,
        state: "exited",
        exit_code: options.exitCode ?? 0,
      })
    else if (path === `/executions/${executionId}/output`)
      reply({
        stdout: { durable_end: output.length, truncated: false },
        stderr: { durable_end: 0, truncated: false },
      })
    else if (path === `/executions/${executionId}/output/stdout?limit=4096`) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" })
      res.end(output)
    } else if (req.method === "POST" && path === `/sandboxes/${sandboxId}/stop`) {
      phase = "stopped"
      if (!lost("stop")) reply({ operation: operation("stop") }, 202)
    } else if (req.method === "DELETE" && path === `/sandboxes/${sandboxId}`) {
      phase = "deleted"
      if (!lost("delete")) reply({ operation: operation("delete") }, 202)
    } else if (path.startsWith("/operations/")) {
      const kind = Object.keys(operationId).find((name) => path.endsWith(operationId[name]))
      reply(operation(kind, kind === "launch" ? executionId : sandboxId))
    } else if (path === `/sandboxes/${sandboxId}`) reply(sandbox())
    else reply({ code: "not_found", unexpected: path }, 404)
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
  assert.ok(
    f.calls.findIndex((c) => c.path.startsWith("/executions/")) <
      f.calls.findIndex((c) => c.method === "DELETE"),
  )
})

for (const drop of ["create", "launch", "stop", "delete"]) {
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
  // The failed operation must end the check; a wall-clock timeout is not evidence
  // that deletion was attempted or that its recovery receipt was persisted.
  await assert.rejects(runOrtamSmoke(f.input), /Ortam deletion failed\. Cleanup is unconfirmed/)
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
  // The launch is keyed, so asking again returns the command already accepted.
  const result = await runOrtamSmoke(f.input)
  assert.equal(result.passed, true)
  assert.equal(result.cleanup_confirmed, true)
  assert.equal(f.starts(), 1)
})

test("a key that cannot see the machine never reports cleanup; a bad receipt or a second reader stops first", async (t) => {
  const f = await fixture(t, { hideAfterLaunch: true })
  // Ortam cannot say whose key this is. Another organization's key sees no such machine,
  // so the check ends with cleanup unconfirmed and the receipt kept for the right key.
  await assert.rejects(
    runOrtamSmoke({ ...f.input, probeMs: 200, cleanupMs: 200 }),
    /Cleanup is unconfirmed; rerun with the same receipt/,
  )
  const receipt = JSON.parse(await readFile(f.statePath, "utf8"))
  assert.equal(receipt.sandbox_id, sandboxId)
  assert.notEqual(receipt.cleanup_confirmed, true)
  await writeFile(f.statePath, JSON.stringify({ ...receipt, version: 1 }))
  await assert.rejects(runOrtamSmoke(f.input), /older Ortam API/)
  await writeFile(f.statePath, "{invalid")
  await assert.rejects(runOrtamSmoke(f.input), /Receipt cannot be read/)
  await writeFile(`${f.statePath}.lock`, "12345\n")
  await assert.rejects(runOrtamSmoke(f.input), /locked/)
  assert.equal(f.creates(), 1)
})

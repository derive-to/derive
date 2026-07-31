import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { signUp } from "../helpers"

// THE FULL WALKTHROUGH, captured against a real deployment as a real signed-in user:
// connect an MCP source → bind it to an automation → run it → see what the run does.
//
// Not a test gate: self-skips unless SHOTS=1.
//   node apps/api/test/weather-mcp-server.mjs 8940 &
//   cloudflared tunnel --url http://localhost:8940 --protocol http2   # a Worker cannot dial localhost
//   SHOTS=1 BASE_URL=https://derive-pr-575.derive-to.workers.dev \
//     WEATHER_MCP_URL=https://<tunnel>/mcp QA_EMAIL=… QA_PASSWORD=… \
//     npx playwright test --project=screens automations
//
// Two things this shows rather than hides:
//   • The Sources screen, driven for real: type a URL, press Connect, and the row that appears
//     means the server actually answered. It was removed once for saying "connected" about an
//     echo stub; it is back because that is no longer what happens.
//   • Whatever the run actually does — captured as-is, never worked around. A refusal for want of
//     a model plan is the payer preflight working. And against the PR preview the hosted executor
//     currently settles a tool-using run as "agent did not produce a revision within 12 turns",
//     while the same automation with the same source bound and an instruction that needs no tool
//     succeeds. That is the executor's loop, not this rail: the rail is exercised end to end by
//     apps/api/test/live-preview-weather.sh, which reads live weather through the deployed tool
//     proxy and writes it into a real document.

const OUT = process.env.SHOT_OUT ?? join(process.cwd(), "test-results", "screens")
const WEATHER = process.env.WEATHER_MCP_URL ?? "http://localhost:8940/mcp"
const BASE = process.env.BASE_URL
const DESKTOP = { width: 1440, height: 900 }

test.use({ deviceScaleFactor: 2, viewport: DESKTOP, ...(BASE ? { baseURL: BASE } : {}) })
test.skip(process.env.SHOTS !== "1", "capture harness — set SHOTS=1")
// Against a deployed target this drives a whole feature over the public internet AND waits for a
// hosted agent to finish a real run. The default 60s expires somewhere around "run now", which
// leaves the automation, the agent and the document behind — the cleanup at the end never runs.
test.setTimeout(BASE ? 10 * 60_000 : 3 * 60_000)

/** The app holds live connections, so `networkidle` never settles — bound it and let it paint. */
const settle = async (page: Page, ms = 900) => {
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {})
  await page.waitForTimeout(ms)
}

const notes: string[] = []
const note = (s: string) => {
  notes.push(s)
  process.stdout.write(`  ${s}\n`)
}

const shot = async (page: Page, name: string) => {
  mkdirSync(OUT, { recursive: true })
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false })
  note(`shot ${name}`)
}

/** Same-origin fetch from inside the signed-in page, so it carries the session cookie. */
const api = (page: Page, path: string, init?: { method?: string; body?: unknown }) =>
  page.evaluate(
    async ([p, i]) => {
      const opts = (i ?? {}) as { method?: string; body?: unknown }
      const res = await fetch(p as string, {
        method: opts.method ?? "GET",
        credentials: "include",
        ...(opts.body
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(opts.body) }
          : {}),
      })
      const text = await res.text()
      try {
        return { status: res.status, body: JSON.parse(text) as unknown }
      } catch {
        return { status: res.status, body: text as unknown }
      }
    },
    [path, init ?? null] as const,
  )

test("MCP sources: connect, automate, run", async ({ page }) => {
  mkdirSync(OUT, { recursive: true })

  // 0. On a DEPLOYED target, sign in as the shared QA account: a fresh signup would litter a
  //    shared workspace and land in a personal one where the beta gates are off. Against the
  //    harness's own local servers there is no such account, so sign up instead.
  if (process.env.QA_EMAIL) {
    await page.goto("/login")
    await page.getByTestId("login-email").fill(process.env.QA_EMAIL)
    await page.getByTestId("login-password").fill(process.env.QA_PASSWORD ?? "")
    await page.getByTestId("login-submit").click()
    await expect(page, "signed in").not.toHaveURL(/\/login/, { timeout: 20_000 })
  } else {
    await signUp(page, "MCP Sources Walkthrough")
  }
  await settle(page)
  note(`signed in at ${BASE ?? "local"}`)

  // 1. Automate is gated per workspace, ships OFF, and has no UI control. Record the prior value
  //    so it goes back exactly as found.
  const before = await api(page, "/v1/workspace/settings")
  const priorAutomate = (before.body as { automateBeta?: boolean })?.automateBeta
  note(`automateBeta was ${String(priorAutomate)}`)
  if (!priorAutomate)
    await api(page, "/v1/workspace/settings", { method: "PATCH", body: { automateBeta: true } })

  // 2. Connect the MCP source THROUGH THE SOURCES SCREEN.
  await page.goto("/settings")
  await settle(page)
  await page.getByTestId("settings-tab-sources").click()
  await settle(page, 600)
  await shot(page, "01-sources-empty")

  await page.getByTestId("source-name").fill("weather")
  await page.getByTestId("source-url").fill(WEATHER)
  await shot(page, "02-sources-filled")
  await page.getByTestId("source-connect").click()
  // The row only appears if the server answered — connect contacts it and pins its tools.
  await expect(page.getByTestId("source-row").first()).toBeVisible({ timeout: 30_000 })
  await settle(page, 600)
  await shot(page, "03-sources-connected")

  const list = await api(page, "/v1/connections?mine=1")
  const conns = (list.body as { connections?: { id: string; kind?: string; toolkit: string }[] })
    ?.connections
  const c = conns?.find((x) => x.toolkit === "weather")
  note(`connected ${JSON.stringify(c)}`)
  writeFileSync(join(OUT, "connect-response.json"), JSON.stringify(c ?? null, null, 2))
  expect(c?.kind, "the row is a live MCP connection").toBe("mcp")

  // 3. The document the automation keeps current. MULTIPART, not JSON — `/v1/artifacts` takes a
  //    file, and a JSON body 400s. Posting JSON here left the automation pointed at no document
  //    at all, and the run then failed with "agent did not produce a revision", which reads like
  //    a broken agent rather than a broken fixture.
  const shortId = await page.evaluate(async (html) => {
    const fd = new FormData()
    fd.append("file", new File([html], "index.html", { type: "text/html" }))
    fd.append("title", "Weather watch (MCP walkthrough)")
    const res = await fetch("/v1/artifacts", {
      method: "POST",
      body: fd,
      credentials: "include",
      headers: { accept: "application/json" },
    })
    const body = (await res.json().catch(() => ({}))) as { short_id?: string }
    return body.short_id ?? null
  }, "<h1>Weather watch</h1><p>No readings yet.</p>")
  expect(shortId, "the document the automation will rewrite").toBeTruthy()
  note(`document ${shortId}`)

  // 4. The automations surface.
  await page.goto("/settings")
  await settle(page)
  await shot(page, "01-settings-automations")

  // 5. The automation form, through the UI.
  const newBtn = page
    .getByRole("button", { name: /new automation|add automation|create automation|automate/i })
    .first()
  if (await newBtn.isVisible().catch(() => false)) {
    await newBtn.click()
    await settle(page, 600)
    await shot(page, "02-automation-form")
    const instruction = page.getByTestId("automation-instruction")
    if (await instruction.isVisible().catch(() => false)) {
      await instruction.fill(
        "Read current weather for London, Tokyo and Reykjavik from the connected weather source and rewrite the table in this document.",
      )
      await page
        .getByTestId("automation-trigger-manual")
        .click()
        .catch(() => {})
      await shot(page, "03-automation-filled")
    }
  } else {
    note("no visible new-automation control — section captured as rendered")
  }

  // 6. Bind the source over the API, so the run under test is exactly this automation, this
  //    connection, this document.
  const agent = await api(page, "/v1/agents", { method: "POST", body: { name: "weather-runner" } })
  const auto = await api(page, "/v1/automations", {
    method: "POST",
    body: {
      agentId: (agent.body as { id?: string })?.id,
      instruction: "Rewrite the weather table from the connected weather source.",
      trigger: { kind: "manual" },
      connectionIds: [c?.id],
      refs: [{ kind: "artifact", id: shortId }],
    },
  })
  const autoId = (auto.body as { id?: string })?.id
  note(`automation ${autoId ?? "not created"} (${auto.status})`)
  await page.goto("/settings")
  await settle(page)
  await shot(page, "04-automation-created")

  // 7. RUN NOW. A refusal — 402 for want of a model plan, say — is as much a result as a success,
  //    and gets captured as-is rather than worked around.
  const run = await api(page, `/v1/automations/${autoId}/run`, { method: "POST" })
  note(`run now -> ${run.status} ${JSON.stringify(run.body).slice(0, 200)}`)
  writeFileSync(join(OUT, "run-response.json"), JSON.stringify(run.body, null, 2))
  const runId = (run.body as { id?: string })?.id
  await page.waitForTimeout(3000)
  await page.goto("/settings")
  await settle(page)
  await shot(page, "05-run-fired")

  // 8. Wait for a real hosted agent to actually finish, then read the ledger a human reads.
  //    Screenshotting a `queued` row would prove only that a row exists.
  type Run = { id: string; status: string; meta?: string; timeline?: { last_error?: string } }
  let settled: Run | undefined
  for (let i = 0; i < 40 && runId; i++) {
    const feed = await api(page, "/v1/workspace/runs")
    const found = ((feed.body as { runs?: Run[] })?.runs ?? []).find((r) => r.id === runId)
    if (found && !["queued", "running"].includes(found.status)) {
      settled = found
      break
    }
    await page.waitForTimeout(6000)
  }
  note(`run ${runId} settled ${settled?.status ?? "still in flight"} ${settled?.meta ?? ""}`)
  writeFileSync(join(OUT, "run-settled.json"), JSON.stringify(settled ?? null, null, 2))

  // 9. The document itself — the whole point. Captured whatever the run did to it.
  const finalHtml = await page.evaluate(async (id) => {
    const res = await fetch(`/v1/artifacts/${id}/content`, { credentials: "include" })
    return res.ok ? await res.text() : `HTTP ${res.status}`
  }, shortId)
  writeFileSync(join(OUT, "document-after-run.html"), finalHtml)
  note(`document is ${finalHtml.length} chars after the run`)
  await page.goto(`/artifacts/${shortId}`)
  await settle(page, 2000)
  await shot(page, "06-document")

  // 10. Clean up: shared workspace, production data.
  if (autoId)
    note(
      `cleanup automation -> ${(await api(page, `/v1/automations/${autoId}`, { method: "DELETE" })).status}`,
    )
  if (c?.id)
    note(
      `cleanup connection -> ${(await api(page, `/v1/connections/${c.id}`, { method: "DELETE" })).status}`,
    )
  if (shortId)
    note(
      `cleanup document -> ${(await api(page, `/v1/artifacts/${shortId}`, { method: "DELETE" })).status}`,
    )
  const agentId = (agent.body as { id?: string })?.id
  if (agentId)
    note(
      `cleanup agent -> ${(await api(page, `/v1/agents/${agentId}`, { method: "DELETE" })).status}`,
    )
  if (!priorAutomate) {
    await api(page, "/v1/workspace/settings", { method: "PATCH", body: { automateBeta: false } })
    note("automateBeta restored to false")
  }

  writeFileSync(join(OUT, "walkthrough-log.txt"), notes.join("\n"))
})

import { expect, publishArtifact, test } from "./fixtures"

// The builder page's static promise: both doors render without a model.
// (The conversation itself is model-backed and covered by API tests.)
test("new Context opens the builder with every door", async ({ owner }) => {
  await owner.goto("/contexts")
  await owner.getByTestId("contexts-new-toggle").click()
  await expect(owner).toHaveURL(/\/contexts\/new/)
  await expect(owner.getByTestId("builder-agent-door")).toBeVisible()
  await expect(owner.getByTestId("builder-arxiv-door")).toBeVisible()
  await expect(owner.getByTestId("builder-expert-door")).toBeVisible()
})

// The paper door previews the reference as it is typed and only offers Fetch for a real
// arXiv reference — no network, the same grammar the server applies.
test("the arXiv door reveals the form and previews the reference", async ({ owner }) => {
  await owner.goto("/contexts/new")
  await owner.getByTestId("builder-arxiv-door").click()
  const link = owner.getByTestId("context-arxiv-link")
  await expect(link).toBeVisible()
  await expect(owner.getByTestId("context-arxiv-submit")).toBeDisabled()
  await link.fill("https://example.com/not-a-paper.pdf")
  await expect(owner.getByTestId("context-arxiv-preview")).toHaveText("Not an arXiv link")
  await expect(owner.getByTestId("context-arxiv-submit")).toBeDisabled()
  await link.fill("2401.12345v2")
  await expect(owner.getByTestId("context-arxiv-preview")).toHaveText("arXiv:2401.12345v2")
  await expect(owner.getByTestId("context-arxiv-submit")).toBeEnabled()

  // The paper's implementation is optional, and previewed by the same grammar: a link
  // that is not a repository blocks Fetch rather than failing a minute into the import.
  const code = owner.getByTestId("context-arxiv-code")
  await code.fill("https://bitbucket.org/o/r")
  await expect(owner.getByTestId("context-arxiv-code-preview")).toHaveText(
    "Not a GitHub or GitLab repository",
  )
  await expect(owner.getByTestId("context-arxiv-submit")).toBeDisabled()
  await code.fill("https://github.com/graphdeco-inria/gaussian-splatting")
  await expect(owner.getByTestId("context-arxiv-code-preview")).toHaveText(
    "github.com/graphdeco-inria/gaussian-splatting",
  )
  await expect(owner.getByTestId("context-arxiv-submit")).toBeEnabled()
  // Empty is fine: a paper needs no implementation.
  await code.fill("")
  await expect(owner.getByTestId("context-arxiv-submit")).toBeEnabled()

  // Opening the other door closes this one.
  await owner.getByTestId("builder-expert-door").click()
  await expect(owner.getByTestId("context-create-name")).toBeVisible()
  await expect(link).toBeHidden()
})

test("the advanced path reveals the manifest form", async ({ owner }) => {
  await owner.goto("/contexts/new")
  await owner.getByTestId("builder-expert-door").click()
  await expect(owner.getByTestId("context-create-name")).toBeVisible()
  await expect(owner.getByTestId("context-create-manifest")).toBeVisible()
})

test("recent Agent URLs redirect to the Context surface", async ({ owner }) => {
  await owner.goto("/agents?name=Analytics&manifest=abc")
  await expect(owner).toHaveURL(/\/contexts\?/)
  const redirected = new URL(owner.url())
  expect(redirected.searchParams.get("name")).toBe("Analytics")
  expect(redirected.searchParams.get("manifest")).toBe("abc")

  await owner.goto("/agents/new")
  await expect(owner).toHaveURL(/\/contexts\/new$/)

  await owner.goto("/agents/ctx_legacy")
  await expect(owner).toHaveURL(/\/contexts\/ctx_legacy$/)
})

test("Context access saves secrets and connections and removes unavailable grants", async ({
  owner,
}) => {
  const manifest = await publishArtifact(owner, "instructions.md", "# Inspect the database")
  const response = await owner.request.post("/v1/contexts", {
    data: { name: "Runtime access", manifest_short_id: manifest },
  })
  expect(response.ok()).toBeTruthy()
  const context = await response.json()
  const sourceResponse = await owner.request.post("/v1/connections", {
    data: {
      toolkit: "test-service",
      kind: "secret",
      secret: "source-fixture-value",
      base_url: "https://service.example.test",
    },
  })
  expect(sourceResponse.ok()).toBeTruthy()
  const source = await sourceResponse.json()
  await owner.goto(`/contexts/${context.id}`)
  // Owning a Context does not expose infrastructure pilot controls.
  await expect(owner.getByTestId("console-tab-chat")).toBeVisible()
  await expect(owner.getByTestId("console-tab-cloud")).toHaveCount(0)
  await expect(owner.getByTestId("context-runtime-sandbox")).toHaveCount(0)
  await owner.getByTestId("context-runtime-access").click()
  await owner.getByTestId(`context-source-${source.id}`).click()
  await expect(owner.getByTestId(`context-source-${source.id}`)).toBeChecked()
  await owner.getByTestId("context-env-name").fill("DERIVE_TOKEN")
  await owner.getByTestId("context-env-value").fill("invalid-name-fixture")
  await expect(owner.getByRole("alert")).toHaveText("This name is reserved for the runner")
  await expect(owner.getByTestId("context-env-add")).toBeDisabled()

  // A slow refresh must not block the saved response from updating the form. The second
  // whole-list write must include the first variable, even before that refresh completes.
  let releaseReads: () => void = () => {}
  const readsReleased = new Promise<void>((resolve) => {
    releaseReads = resolve
  })
  const environmentUrl = `**/v1/contexts/${context.id}/environment`
  await owner.route(environmentUrl, async (route) => {
    if (route.request().method() === "GET") await readsReleased
    await route.continue()
  })
  try {
    await owner.getByTestId("context-env-name").fill("DATABASE_URL")
    await owner.getByTestId("context-env-value").fill("browser-fixture-value")
    await owner.getByTestId("context-env-add").click()
    await expect(owner.getByTestId("context-env-remove-DATABASE_URL")).toBeVisible()
    await expect(owner.getByTestId("context-env-value")).toHaveValue("")
    await owner.getByTestId("context-env-name").fill("REPORT_BUCKET")
    await owner.getByTestId("context-env-value").fill("bucket-fixture")
    await owner.getByTestId("context-env-add").click()
    await expect(owner.getByTestId("context-env-remove-REPORT_BUCKET")).toBeVisible()
  } finally {
    releaseReads()
    await owner.unrouteAll({ behavior: "wait" })
  }
  await owner.reload()
  await owner.getByTestId("context-runtime-access").click()
  await expect(owner.getByTestId(`context-source-${source.id}`)).toBeChecked()
  await expect(owner.getByTestId("context-env-remove-DATABASE_URL")).toBeVisible()
  await expect(owner.getByTestId("context-env-value")).toHaveValue("")
  await expect(owner.getByTestId("context-env-remove-REPORT_BUCKET")).toBeVisible()
  await owner.getByTestId("context-env-remove-REPORT_BUCKET").click()
  await expect(owner.getByTestId("context-env-remove-REPORT_BUCKET")).toHaveCount(0)
  await owner.getByTestId("context-env-remove-DATABASE_URL").click()
  await expect(owner.getByTestId("context-env-remove-DATABASE_URL")).toHaveCount(0)
  expect((await owner.request.delete(`/v1/connections/${source.id}`)).ok()).toBeTruthy()
  await owner.reload()
  await owner.getByTestId("context-runtime-access").click()
  await owner.getByTestId("context-sources-remove-unavailable").click()
  await expect(owner.getByTestId("context-sources-remove-unavailable")).toHaveCount(0)
})

test("Cloud runs queue the chosen task and show report and shutdown separately", async ({
  owner,
}, testInfo) => {
  const manifest = await publishArtifact(owner, "daily.md", "# Run the existing daily checks")
  const created = await owner.request.post("/v1/contexts", {
    data: { name: "Daily checks", manifest_short_id: manifest },
  })
  const context = await created.json()
  // Keep transient toast feedback out of the layout captures. Error feedback is asserted below.
  const screenshotStyle = "[data-sonner-toaster] { visibility: hidden; }"
  let binding: { connection_id: string; sandbox_id: string } | null = null
  let disabledAt: string | null = null
  let queued = false
  let pilotAllowed = true
  let unavailableReads = 4
  let rejectRuntimeRefresh = false
  let submitted: unknown
  const scheduleState: { current: Record<string, unknown> | null } = { current: null }
  let releasePause: (() => void) | undefined
  let holdPause = false
  await owner.route(`**/v1/contexts/${context.id}/runtime`, async (route) => {
    if (route.request().method() === "POST") {
      binding = route.request().postDataJSON()
      await route.fulfill({ status: 201, json: { runtime: { id: "runtime-demo" } } })
      return
    }
    if (unavailableReads > 0) {
      unavailableReads--
      await route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } })
      return
    }
    if (rejectRuntimeRefresh) {
      await route.fulfill({ status: 403, json: { error: "Access check unavailable" } })
      return
    }
    await route.fulfill({
      json: {
        enabled: pilotAllowed,
        schedule: scheduleState.current,
        next_run_at: scheduleState.current?.enabled ? "2026-09-22T13:00:00.000Z" : null,
        runtime: binding
          ? { id: "runtime-demo", sandbox_id: binding.sandbox_id, disabled_at: disabledAt }
          : null,
        runs: queued
          ? [
              {
                id: "run-demo",
                created_at: "2026-09-21T12:00:00.000Z",
                status: "running",
                meta: null,
                attempt: {
                  phase: "stopping",
                  result_json: JSON.stringify({ summary: "Checks complete." }),
                  released_at: null,
                },
              },
            ]
          : [],
      },
    })
  })
  await owner.route(`**/v1/contexts/${context.id}/runtime/runs`, async (route) => {
    submitted = route.request().postDataJSON()
    queued = true
    await route.fulfill({ status: 201, json: { run: { id: "run-demo" } } })
  })
  await owner.route(`**/v1/contexts/${context.id}/runtime/disable`, async (route) => {
    disabledAt = new Date().toISOString()
    await route.fulfill({ json: { ok: true } })
  })
  await owner.route(`**/v1/contexts/${context.id}/runtime/schedule`, async (route) => {
    const body = route.request().postDataJSON()
    expect(body.revision).toBe(scheduleState.current?.revision ?? null)
    const savedSchedule = {
      ...body,
      enabled: body.enabled ? 1 : 0,
      revision: (body.revision ?? -1) + 1,
      trigger: JSON.stringify({ kind: "schedule", cron: body.cron, tz: body.timezone }),
    }
    scheduleState.current = savedSchedule
    if (holdPause && !body.enabled)
      await new Promise<void>((resolve) => {
        releasePause = resolve
      })
    await route.fulfill({
      json: {
        schedule: savedSchedule,
        next_run_at: savedSchedule.enabled ? "2026-09-22T13:00:00.000Z" : null,
      },
    })
  })
  let rejectConnectionReads = true
  let rejectKeySave = true
  await owner.route("**/v1/connections?*", async (route) => {
    if (rejectConnectionReads) {
      await route.fulfill({ status: 403, json: { error: "Connections unavailable" } })
      return
    }
    await route.continue()
  })
  await owner.route("**/v1/connections", async (route) => {
    if (route.request().method() === "POST" && rejectKeySave) {
      await route.fulfill({ status: 503, json: { error: "Secret storage unavailable" } })
      return
    }
    await route.continue()
  })
  await owner.setViewportSize({ width: 1440, height: 1100 })
  await owner.goto(`/contexts/${context.id}`)
  await owner.getByTestId("console-tab-cloud").click()
  await expect(owner.getByTestId("context-runtime-connections-retry")).toBeVisible()
  await expect(owner.getByTestId("context-runtime-connection")).toBeDisabled()
  rejectConnectionReads = false
  await owner.getByTestId("context-runtime-connections-retry").click()
  await expect(owner.getByTestId("context-runtime-connection")).toBeEnabled()
  await expect(owner.getByTestId("context-runtime-connections-retry")).toBeHidden()
  await expect(owner.getByTestId("context-runtime-key-save")).toBeDisabled()
  await owner.getByTestId("context-runtime-key").fill("controller-key-fixture")
  await owner.getByTestId("console-tab-chat").click()
  await expect(owner.getByTestId("context-runtime-key")).toBeHidden()
  await owner.getByTestId("console-tab-cloud").click()
  await expect(owner.getByTestId("context-runtime-key")).toHaveValue("controller-key-fixture")
  await owner.getByTestId("context-runtime-key-save").click()
  await expect(owner.getByText("Secret storage unavailable", { exact: true })).toBeVisible()
  await expect(owner.getByTestId("context-runtime-key")).toHaveValue("controller-key-fixture")
  await expect(owner.getByTestId("context-runtime-bind")).toBeDisabled()
  rejectKeySave = false
  await owner.getByTestId("context-runtime-key-save").click()
  await expect(owner.getByTestId("context-runtime-key")).toHaveValue("")
  const saved = await owner.request.get("/v1/connections?mine=1")
  const secrets = (await saved.json()).connections
  expect(secrets).toHaveLength(1)
  expect(secrets[0]).toMatchObject({ toolkit: "ortam", kind: "secret", scope: "personal" })
  expect(JSON.stringify(secrets)).not.toContain("controller-key-fixture")
  await expect(owner.getByTestId("context-runtime-connection")).toHaveValue(secrets[0].id)
  // Controller credentials must never become task environment variables or source grants.
  const environment = await owner.request.get(`/v1/contexts/${context.id}/environment`)
  expect((await environment.json()).bindings).toEqual({})
  const detail = await owner.request.get(`/v1/contexts/${context.id}`)
  expect((await detail.json()).connection_ids).toEqual([])
  const sandbox = "sbx_00000000000000000000000000"
  await owner.getByTestId("context-runtime-sandbox").fill(sandbox)
  await owner.getByTestId("context-runtime-key").fill(" ")
  await expect(owner.getByTestId("context-runtime-bind")).toBeEnabled()
  await owner.getByTestId("context-runtime-key").fill("")
  await owner
    .getByTestId("context-runtime-panel")
    .screenshot({ path: testInfo.outputPath("cloud-run-setup.png"), style: screenshotStyle })
  await owner.getByTestId("context-runtime-bind").click()
  await expect(owner.getByTestId("context-runtime-run")).toBeDisabled()
  expect(binding).toEqual({ connection_id: secrets[0].id, sandbox_id: sandbox })
  await owner
    .getByTestId("context-runtime-instruction")
    .fill("Run the anti-cheat script and explain unusual results")
  await owner.getByTestId("context-runtime-provider").selectOption("claude-code")
  await owner.getByTestId("context-runtime-run").click()
  await expect(owner.getByText("Report received · Waiting for shutdown confirmation")).toBeVisible()
  expect(submitted).toEqual({
    instruction: "Run the anti-cheat script and explain unusual results",
    provider: "claude-code",
  })
  await expect(owner.getByTestId("context-runtime-instruction")).toHaveValue("")
  await owner.getByText("Read received report").click()
  await expect(owner.getByText("Checks complete.")).toBeVisible()
  await owner
    .getByTestId("context-runtime-schedule-instruction")
    .fill("Run the anti-cheat script and report anything suspicious")
  await owner.getByTestId("context-runtime-schedule-cron").fill("0 9 * * *")
  await owner.getByTestId("context-runtime-schedule-timezone").fill("America/New_York")
  await owner.getByTestId("context-runtime-schedule-save").click()
  await expect(owner.getByText(/Next run:.*America\/New_York/)).toBeVisible()
  expect(scheduleState.current).toMatchObject({
    cron: "0 9 * * *",
    timezone: "America/New_York",
    enabled: 1,
  })
  await owner
    .getByTestId("context-runtime-panel")
    .screenshot({ path: testInfo.outputPath("cloud-runs.png"), style: screenshotStyle })
  await owner
    .getByTestId("context-runtime-schedule")
    .screenshot({ path: testInfo.outputPath("schedule.png"), style: screenshotStyle })
  await owner.getByTestId("context-runtime-schedule-instruction").fill("My unsaved investigation")
  rejectRuntimeRefresh = true
  await expect(owner.getByTestId("context-runtime-runs-retry")).toBeVisible()
  await expect(owner.getByTestId("context-runtime-schedule-instruction")).toHaveValue(
    "My unsaved investigation",
  )
  rejectRuntimeRefresh = false
  await owner.getByTestId("context-runtime-runs-retry").click()
  await expect(owner.getByTestId("context-runtime-runs-retry")).toBeHidden()
  await owner.getByTestId("console-tab-chat").click()
  await owner.getByTestId("console-tab-cloud").click()
  await expect(owner.getByTestId("context-runtime-schedule-instruction")).toHaveValue(
    "My unsaved investigation",
  )
  scheduleState.current = {
    ...scheduleState.current,
    revision: 1,
    instruction: "Another editor's saved task",
  }
  // The five-second query refresh must preserve both the draft and its original revision.
  await expect(
    owner.getByText("The schedule changed elsewhere. Your unsaved draft has been kept."),
  ).toBeVisible()
  await expect(owner.getByTestId("context-runtime-schedule-instruction")).toHaveValue(
    "My unsaved investigation",
  )
  await expect(owner.getByTestId("context-runtime-schedule-save")).toBeDisabled()
  await owner.getByTestId("context-runtime-schedule-pause").click()
  await expect(owner.getByText("Schedule paused", { exact: true })).toBeVisible()
  // Pausing the current schedule does not grant permission to overwrite another editor's changes.
  await expect(owner.getByTestId("context-runtime-schedule-save")).toBeDisabled()
  await owner.getByTestId("context-runtime-schedule-reload").click()
  await expect(owner.getByTestId("context-runtime-schedule-instruction")).toHaveValue(
    "Another editor's saved task",
  )
  await owner.getByTestId("context-runtime-schedule-save").click()
  await expect(owner.getByTestId("context-runtime-schedule-pause")).toBeVisible()
  await owner
    .getByTestId("context-runtime-schedule-instruction")
    .fill("Keep this draft while pausing")
  holdPause = true
  await owner.getByTestId("context-runtime-schedule-pause").click()
  // A poll can observe our own pause before its PUT response arrives.
  await expect(owner.getByText("Schedule paused", { exact: true })).toBeVisible()
  releasePause?.()
  await expect(owner.getByTestId("context-runtime-schedule-save")).toBeEnabled()
  await expect(owner.getByTestId("context-runtime-schedule-instruction")).toHaveValue(
    "Keep this draft while pausing",
  )
  expect(scheduleState.current).toMatchObject({
    instruction: "Another editor's saved task",
    enabled: 0,
  })
  await owner.getByTestId("context-runtime-schedule-save").click()
  await expect(owner.getByTestId("context-runtime-schedule-pause")).toBeVisible()
  expect(scheduleState.current).toMatchObject({
    instruction: "Keep this draft while pausing",
    revision: 5,
    enabled: 1,
  })
  await owner.evaluate(() => document.documentElement.classList.add("dark"))
  await owner
    .getByTestId("context-runtime-panel")
    .screenshot({ path: testInfo.outputPath("cloud-runs-dark.png"), style: screenshotStyle })
  await owner.evaluate(() => document.documentElement.classList.remove("dark"))
  await owner.setViewportSize({ width: 390, height: 844 })
  await expect(owner.getByTestId("context-runtime-run")).toBeVisible()
  expect(
    await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true)
  await owner.getByTestId("context-runtime-instruction").scrollIntoViewIfNeeded()
  await owner.screenshot({
    path: testInfo.outputPath("cloud-runs-mobile.png"),
    style: screenshotStyle,
  })
  await owner.getByTestId("context-runtime-schedule-details").scrollIntoViewIfNeeded()
  await owner.screenshot({
    path: testInfo.outputPath("cloud-runs-mobile-schedule.png"),
    style: screenshotStyle,
  })
  await owner.setViewportSize({ width: 1440, height: 1100 })
  await owner.getByTestId("context-runtime-disable").click()
  await expect(owner.getByRole("dialog")).toBeVisible()
  await owner.getByTestId("confirm-dialog-cancel").click()
  expect(disabledAt).toBeNull()
  await owner.getByTestId("context-runtime-disable").click()
  await owner.getByTestId("confirm-dialog-confirm").click()
  await expect(
    owner.getByText("Cloud runs are disabled. Previous reports remain available below."),
  ).toBeVisible()
  await expect(owner.getByTestId("context-runtime-run")).toBeHidden()
  await expect(owner.getByText("Checks complete.")).toBeVisible()
  pilotAllowed = false
  await expect(owner.getByTestId("console-tab-cloud")).toHaveCount(0)
  await expect(owner.getByTestId("console-tab-chat")).toHaveAttribute("data-state", "active")
  await expect(owner.getByTestId("context-runtime-panel")).toHaveCount(0)
})

test("Cloud setup accepts a saved connection and keeps consent and cancellation visible", async ({
  owner,
}, testInfo) => {
  const manifest = await publishArtifact(owner, "setup.md", "# Daily checks")
  const created = await owner.request.post("/v1/contexts", {
    data: { name: "Provisioned checks", manifest_short_id: manifest },
  })
  const context = await created.json()
  let setup: Record<string, unknown> | null = null
  await owner.route("**/v1/connections?*", (route) =>
    route.fulfill({
      json: {
        connections: [
          {
            id: "setup-controller",
            kind: "secret",
            status: "active",
            toolkit: "ortam",
            scopes_label: "Pilot controller",
          },
        ],
      },
    }),
  )
  await owner.route(`**/v1/contexts/${context.id}/runtime`, (route) =>
    route.fulfill({
      json: { enabled: true, runtime: null, schedule: null, next_run_at: null, runs: [], setup },
    }),
  )
  await owner.route(`**/v1/contexts/${context.id}/runtime/setup`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ connection_id: "setup-controller" })
    setup = {
      id: "setup-demo",
      phase: "awaiting_connection",
      sandbox_id: "sbx_operator_pilot",
      cancelled_at: null,
      deadline_at: new Date(Date.now() + 20 * 60000).toISOString(),
    }
    await route.fulfill({ status: 202, json: { setup } })
  })
  await owner.route(`**/v1/contexts/${context.id}/runtime/setup/cancel`, async (route) => {
    setup = { ...setup, phase: "deleting", cancelled_at: new Date().toISOString() }
    await route.fulfill({ json: { setup } })
  })
  await owner.goto(`/contexts/${context.id}`)
  await owner.getByTestId("console-tab-cloud").click()
  await expect(owner.getByTestId("context-runtime-provision")).toBeDisabled()
  await owner.getByTestId("context-runtime-connection").selectOption("setup-controller")
  await owner.getByTestId("context-runtime-provision").click()
  await expect(owner.getByText("Attach your model account", { exact: true })).toBeVisible()
  await expect(owner.getByTestId("context-runtime-run")).toHaveCount(0)
  await owner.setViewportSize({ width: 390, height: 844 })
  await owner
    .getByTestId("context-runtime-panel")
    .screenshot({ path: testInfo.outputPath("setup-consent-mobile.png") })
  await owner.getByTestId("context-runtime-setup-cancel").click()
  await expect(owner.getByText("Cancelling setup", { exact: true })).toBeVisible()
  await expect(owner.getByTestId("context-runtime-setup-cancel")).toHaveCount(0)
})

test("Cloud managed jobs connect a provider and run the saved agent without infrastructure setup", async ({
  owner,
}, testInfo) => {
  const manifest = await publishArtifact(
    owner,
    "managed-job.md",
    "# Keep the job’s files and run its checks",
  )
  const created = await owner.request.post("/v1/contexts", {
    data: { name: "Shared daily job", manifest_short_id: manifest },
  })
  const context = await created.json()
  let connected = false
  let selected = false
  let revision: number | null = null
  let disconnected = false
  const account = {
    id: "model-demo",
    name: "Work account",
    provider: "codex",
    revision: 0,
    revoked_at: null,
  }
  const selection = () =>
    selected ? { ...account, revoked: disconnected, can_manage: editable } : null
  let prepared = false
  let editable = true
  let fired: unknown
  const job = {
    id: "job-demo",
    instruction: "Check the saved data and report changes",
    provider: "codex",
    enabled: 1,
    revision: 0,
    trigger: JSON.stringify({ kind: "schedule", cron: "0 9 * * *", tz: "UTC" }),
  }
  await owner.route(`**/v1/contexts/${context.id}/runtime`, (route) =>
    route.fulfill({
      json: {
        enabled: true,
        managed: true,
        model_connection: selection(),
        can_edit: editable,
        runtime: prepared ? { id: "runtime-demo", disabled_at: null } : null,
        setup: null,
        schedule: prepared ? job : null,
        next_run_at: "2026-09-24T09:00:00.000Z",
        runs: [],
      },
    }),
  )
  await owner.route("**/v1/runtime-model-connections?include_revoked=true", (route) =>
    route.fulfill({
      json: { items: [{ ...account, revoked_at: disconnected ? "2026-09-23T12:00:00Z" : null }] },
    }),
  )
  await owner.route(`**/v1/contexts/${context.id}/runtime/model-connection`, async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON()
      expect(body.revision).toBe(revision)
      selected = body.connection_id === account.id
      revision = (revision ?? -1) + 1
      await route.fulfill({ json: { revision, connection_id: selected ? account.id : null } })
    } else await route.fulfill({ json: { revision, connection: selection() } })
  })
  await owner.route("**/v1/runtime-model-connections/model-demo/status", (route) =>
    route.fulfill({
      json: {
        revoked: disconnected,
        account: connected ? { status: "active", identity: { email: "model@example.test" } } : null,
      },
    }),
  )
  await owner.route("**/v1/runtime-model-connections/model-demo", async (route) => {
    expect(route.request().method()).toBe("DELETE")
    disconnected = true
    await route.fulfill({ json: { revoked: true } })
  })
  const attempt = {
    id: "login-demo",
    state: "pending",
    user_code: "ABCD-1234",
    verification_url: "https://auth.openai.com/codex/device",
    authorize_url: null,
    expires_at: new Date(Date.now() + 600000).toISOString(),
  }
  await owner.route("**/v1/runtime-model-connections/model-demo/sign-in", (route) =>
    route.fulfill({ status: 202, json: attempt }),
  )
  await owner.route("**/v1/runtime-model-connections/model-demo/sign-in/login-demo", (route) =>
    route.fulfill({ json: { ...attempt, state: connected ? "complete" : "pending" } }),
  )
  await owner.route(`**/v1/contexts/${context.id}/runtime/setup`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({})
    prepared = true
    await route.fulfill({ status: 202, json: { setup: { phase: "queued" } } })
  })
  await owner.route(`**/v1/contexts/${context.id}/runtime/runs`, async (route) => {
    fired = route.request().postDataJSON()
    await route.fulfill({ status: 201, json: { run: { id: "run-demo" } } })
  })
  await owner.goto(`/contexts/${context.id}`)
  await owner.getByTestId("console-tab-cloud").click()
  await expect(owner.getByTestId("context-managed-setup")).toBeDisabled()
  await owner.getByTestId("context-model-account-select").selectOption(account.id)
  await owner.getByTestId("context-managed-model-connect").click()
  await expect(owner.getByText("ABCD-1234", { exact: true })).toBeVisible()
  await expect(owner.getByTestId("context-managed-model-authorize")).toHaveAttribute(
    "href",
    attempt.verification_url,
  )
  await expect(owner.getByTestId("context-runtime-connection")).toHaveCount(0)
  await expect(owner.getByText(/Ortam|sandbox ID|controller key/i)).toHaveCount(0)
  connected = true
  await expect(owner.getByText("Account connected.", { exact: true })).toBeVisible({
    timeout: 15000,
  })
  await owner.getByTestId("context-model-account-use").click()
  await owner.getByTestId("context-managed-setup").click()
  await expect(owner.getByTestId("context-runtime-schedule-provider")).toBeDisabled()
  await expect(owner.getByTestId("context-managed-run")).toBeVisible()
  await owner.getByTestId("context-managed-run").click()
  expect(fired).toEqual({})
  await owner.getByTestId("context-model-account-remove").click()
  await expect(owner.getByText("Remove this job’s account access?", { exact: true })).toBeVisible()
  await owner.getByTestId("confirm-dialog-confirm").click()
  await expect(owner.getByTestId("context-managed-run")).toBeDisabled()
  expect(disconnected).toBe(false)
  await owner.getByTestId("context-model-account-select").selectOption(account.id)
  await owner.getByTestId("context-model-account-use").click()
  await expect(owner.getByTestId("context-managed-run")).toBeEnabled()
  await owner.getByTestId("context-managed-model-disconnect").click()
  await expect(
    owner.getByText("Disconnect this account from all jobs?", { exact: true }),
  ).toBeVisible()
  await owner.getByTestId("confirm-dialog-cancel").click()
  expect(disconnected).toBe(false)
  await expect(owner.getByRole("dialog")).toBeHidden()
  await owner.screenshot({ path: testInfo.outputPath("managed-model-owner.png"), fullPage: true })
  editable = false
  await owner.reload()
  await owner.getByTestId("console-tab-cloud").click()
  await expect(owner.getByTestId("context-managed-model-connect")).toHaveCount(0)
  await expect(owner.getByTestId("context-runtime-schedule-save")).toHaveCount(0)
  await expect(owner.getByTestId("context-managed-run")).toBeEnabled()
  await expect(owner.getByText("Work account · Codex", { exact: true })).toBeVisible()
  await owner.setViewportSize({ width: 390, height: 844 })
  await owner.screenshot({ path: testInfo.outputPath("managed-job-mobile.png"), fullPage: true })
})

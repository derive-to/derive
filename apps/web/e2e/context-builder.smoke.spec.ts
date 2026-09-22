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
  let queued = false
  let submitted: unknown
  let schedule: Record<string, unknown> | null = null
  let releasePause: (() => void) | undefined
  let holdPause = false
  await owner.route(`**/v1/contexts/${context.id}/runtime`, async (route) =>
    route.fulfill({
      json: {
        enabled: true,
        schedule,
        next_run_at: schedule?.enabled ? "2026-09-22T13:00:00.000Z" : null,
        runtime: { id: "runtime-demo", disabled_at: null },
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
    }),
  )
  await owner.route(`**/v1/contexts/${context.id}/runtime/runs`, async (route) => {
    submitted = route.request().postDataJSON()
    queued = true
    await route.fulfill({ status: 201, json: { run: { id: "run-demo" } } })
  })
  await owner.route(`**/v1/contexts/${context.id}/runtime/schedule`, async (route) => {
    const body = route.request().postDataJSON()
    expect(body.revision).toBe(schedule?.revision ?? null)
    schedule = {
      ...body,
      enabled: body.enabled ? 1 : 0,
      revision: (body.revision ?? -1) + 1,
      trigger: JSON.stringify({ kind: "schedule", cron: body.cron, tz: body.timezone }),
    }
    if (holdPause && !body.enabled)
      await new Promise<void>((resolve) => {
        releasePause = resolve
      })
    await route.fulfill({
      json: { schedule, next_run_at: schedule.enabled ? "2026-09-22T13:00:00.000Z" : null },
    })
  })
  await owner.goto(`/contexts/${context.id}`)
  await expect(owner.getByTestId("context-runtime-run")).toBeDisabled()
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
  expect(schedule).toMatchObject({ cron: "0 9 * * *", timezone: "America/New_York", enabled: 1 })
  await owner
    .locator("section")
    .filter({ has: owner.getByTestId("context-runtime-run") })
    .screenshot({ path: testInfo.outputPath("cloud-runs.png") })
  await owner
    .getByTestId("context-runtime-schedule")
    .screenshot({ path: testInfo.outputPath("schedule.png") })
  await owner.getByTestId("context-runtime-schedule-instruction").fill("My unsaved investigation")
  schedule = { ...schedule, revision: 1, instruction: "Another editor's saved task" }
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
  expect(schedule).toMatchObject({ instruction: "Another editor's saved task", enabled: 0 })
  await owner.getByTestId("context-runtime-schedule-save").click()
  await expect(owner.getByTestId("context-runtime-schedule-pause")).toBeVisible()
  expect(schedule).toMatchObject({
    instruction: "Keep this draft while pausing",
    revision: 5,
    enabled: 1,
  })
})

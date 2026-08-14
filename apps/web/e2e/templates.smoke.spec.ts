import type { Page } from "@playwright/test"
import { expect, publishArtifact, test } from "./fixtures"

async function addWorkspaceStarter(page: Page, sourceShortId: string) {
  const libraryResponse = await page.request.post("/v1/template-libraries", {
    data: {
      title: "Launch systems",
      description: "Reusable launch artifacts.",
      scope: "workspace",
    },
  })
  expect(libraryResponse.ok(), await libraryResponse.text()).toBeTruthy()
  const library = (await libraryResponse.json()) as { id: string }

  const entryResponse = await page.request.post(`/v1/template-libraries/${library.id}/entries`, {
    data: {
      source_short_id: sourceShortId,
      kind: "artifact",
      category: "Site",
      title: "Launch command center",
      description: "A reusable live launch view.",
      outcome: "One operating view for launch readiness.",
      sections: ["Readiness", "Proof", "Owners"],
      inputs: [{ name: "brief", description: "What must this launch accomplish?", required: true }],
      tags: ["launch"],
    },
  })
  expect(entryResponse.ok(), await entryResponse.text()).toBeTruthy()
  const entry = (await entryResponse.json()) as { id: string }
  return { libraryId: library.id, entryId: entry.id }
}

test.describe("templates", () => {
  test("choosing a template prepares a complete handoff for the user's local agent", async ({
    owner: page,
  }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    await page.goto("/templates")
    await page.getByTestId("template-use-narrative-pitch").click()

    await expect(page.getByRole("heading", { name: "Make Narrative pitch yours" })).toBeVisible()
    await expect(page.getByText("Use your own agent")).toBeVisible()
    await expect(page.getByText("Continue locally")).toBeVisible()
    await expect(page.getByTestId("artifact-source-editor")).toHaveCount(0)
    await page
      .getByTestId("template-agent-brief")
      .fill("A customer-onboarding story for Acme’s product and success leaders.")
    await page.getByTestId("template-agent-copy").click()
    const handoff = await page.evaluate(() => navigator.clipboard.readText())
    expect(handoff).toContain("Exact reference: derive://templates/narrative-pitch")
    expect(handoff).toContain("customer-onboarding story")
    expect(handoff).toContain("Use Derive's read tool")
    expect(handoff).toContain("Use find")
    expect(handoff).toContain("visually inspect")
    expect(new URL(page.url()).pathname).toBe("/templates")
  })

  test("an online Context runner picks up the complete template job automatically", async ({
    owner: page,
  }) => {
    const now = new Date().toISOString()
    let queuedBody: Record<string, unknown> | null = null
    await page.route("**/v1/contexts", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          contexts: [
            {
              id: "ctx_local_codex",
              name: "My local Codex",
              agent_id: "ag_local_codex",
              manifest_short_id: "manifest_local_codex",
              created_by: "usr_owner",
              created_at: now,
              runner_seen_at: now,
              ask_policy: "workspace",
              connection_ids: [],
              description: "Runs template work on this machine.",
              skills_count: 0,
              manifest_version: 1,
            },
          ],
        }),
      }),
    )
    await page.route("**/v1/contexts/ctx_local_codex/sessions", async (route) => {
      if (route.request().method() === "POST") {
        queuedBody = route.request().postDataJSON() as Record<string, unknown>
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ session: { id: "ses_template_local" }, messages: [] }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [], next_cursor: null }),
      })
    })
    await page.route("**/v1/contexts/ctx_local_codex", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "ctx_local_codex",
          name: "My local Codex",
          agent_id: "ag_local_codex",
          manifest_short_id: "manifest_local_codex",
          created_by: "usr_owner",
          created_at: now,
          runner_seen_at: now,
          ask_policy: "workspace",
          connection_ids: [],
          skills: [],
        }),
      }),
    )

    await page.goto("/templates")
    await page.getByTestId("template-use-narrative-pitch").click()
    await expect(page.getByTestId("template-agent-connected-runner")).toBeVisible()
    await expect(page.getByTestId("template-agent-run-connected")).toContainText(
      "Send to My local Codex",
    )
    await page
      .getByTestId("template-agent-brief")
      .fill("Make an evidence-led onboarding deck for Acme's executive team.")
    await page.getByTestId("template-agent-run-connected").click()

    await expect(page).toHaveURL(/\/contexts\/ctx_local_codex/)
    expect(queuedBody).toMatchObject({
      body_md: expect.stringContaining("derive://templates/narrative-pitch"),
    })
    expect(JSON.stringify(queuedBody)).toContain("evidence-led onboarding deck")
    expect(JSON.stringify(queuedBody)).toContain("Use Derive's read tool")
  })

  test("automatic pickup explains the one-time model-plan setup instead of leaking a billing error", async ({
    owner: page,
  }) => {
    const now = new Date().toISOString()
    await page.route("**/v1/contexts", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          contexts: [
            {
              id: "ctx_needs_plan",
              name: "My local Claude",
              agent_id: "ag_needs_plan",
              manifest_short_id: "manifest_needs_plan",
              created_by: "usr_owner",
              created_at: now,
              runner_seen_at: now,
              ask_policy: "workspace",
              connection_ids: [],
            },
          ],
        }),
      }),
    )
    await page.route("**/v1/contexts/ctx_needs_plan/sessions", (route) =>
      route.fulfill({
        status: 402,
        contentType: "application/json",
        body: JSON.stringify({ error: "no model plan is connected for this work" }),
      }),
    )

    await page.goto("/templates")
    await page.getByTestId("template-use-narrative-pitch").click()
    await page.getByTestId("template-agent-brief").fill("Make a customer proof deck.")
    await page.getByTestId("template-agent-run-connected").click()

    await expect(
      page.getByText("This machine is online, but it still needs a model plan."),
    ).toBeVisible()
    await expect(page.getByTestId("template-agent-connect-plan")).toBeVisible()
    await expect(page.getByText("no model plan is connected", { exact: false })).toHaveCount(0)
    await expect(page.getByTestId("template-agent-open-codex")).toBeEnabled()
  })

  test("the default workflow exposes only local-agent paths", async ({ owner: page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    let hostedStarts = 0
    await page.route("**/v1/contexts", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Connected machines are temporarily unavailable." }),
      }),
    )
    await page.route("**/v1/chat-session", (route) => {
      hostedStarts++
      return route.abort()
    })
    await page.goto("/templates")
    await page.getByTestId("template-use-narrative-pitch").click()
    await page.getByTestId("template-agent-brief").fill("Make a customer launch story.")

    await expect(page.getByText("Continue locally")).toBeVisible()
    await expect(page.getByTestId("template-agent-open-codex")).toBeEnabled()
    await expect(page.getByTestId("template-agent-open-claude")).toBeEnabled()
    await expect(page.getByTestId("template-agent-copy")).toBeEnabled()
    await expect(page.getByTestId("template-agent-contexts-retry")).toBeVisible()
    await expect(page.getByText("hosted", { exact: false })).toHaveCount(0)
    await expect(page.getByTestId("template-agent-build-beta")).toHaveCount(0)
    await page.getByTestId("template-agent-copy").click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
      "Make a customer launch story.",
    )
    expect(hostedStarts).toBe(0)
  })

  test("a blocked clipboard reveals a selectable manual fallback", async ({ owner: page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error("blocked")) },
      })
    })
    await page.goto("/templates")
    await page.getByTestId("template-use-narrative-pitch").click()
    await page.getByTestId("template-agent-brief").fill("Make this ours without changing source.")
    await page.getByTestId("template-agent-copy").click()

    await expect(page.getByTestId("template-agent-error")).toContainText("Select the handoff")
    await expect(page.getByTestId("template-agent-handoff-preview")).toBeVisible()
    await expect(page.getByLabel("Agent handoff to copy")).not.toBeEditable()
  })

  test("any existing artifact can become an agentic starting point", async ({ owner: page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    const source = await publishArtifact(
      page,
      "customer-proof.html",
      "<main><h1>Customer proof</h1><p>24 teams reached value in one day.</p></main>",
      "text/html",
    )
    await page.goto("/templates?derive=true")
    await page.getByTestId("template-source-input").fill(source)
    await page.getByTestId("template-source-submit").click()

    await expect(page.getByRole("heading", { name: "Make customer-proof yours" })).toBeVisible()
    await page
      .getByTestId("template-agent-brief")
      .fill("Turn this evidence into a concise launch page for operations leaders.")
    await page.getByTestId("template-agent-copy").click()
    const handoff = await page.evaluate(() => navigator.clipboard.readText())
    expect(handoff).toContain(source)
    expect(handoff).toContain("Turn this evidence")
    expect(new URL(page.url()).pathname).toBe("/templates")
  })

  test("the mobile card exposes its agent action without scrolling to the detail rail", async ({
    owner: page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto("/templates")
    const firstCard = page.getByTestId("template-card-narrative-pitch")
    await expect(firstCard).toBeInViewport()
    await expect(firstCard.getByRole("button", { name: "Make it mine" })).toBeVisible()
  })

  test("a preview ahead of additive schema explains the beta release state", async ({
    owner: page,
  }) => {
    await page.route("**/v1/template-libraries?**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: "template libraries are waiting for the database update",
          code: "template_library_schema_unavailable",
        }),
      }),
    )
    await page.goto("/templates?tab=libraries")

    await expect(page.getByText("Template libraries are landing with this release")).toBeVisible()
    await expect(
      page.getByText("Shared libraries turn on automatically when the release finishes."),
    ).toBeVisible()
    await expect(page.getByTestId("template-library-retry")).toHaveCount(0)
  })

  test("a legacy deck link resumes the same agent-first flow without exposing source", async ({
    owner: page,
  }) => {
    await page.goto("/new?template=narrative-pitch")
    await expect(page).toHaveURL(/\/templates\?use=narrative-pitch/)
    await expect(page.getByRole("heading", { name: "Make Narrative pitch yours" })).toBeVisible()
    await expect(page.getByTestId("artifact-source-editor")).toHaveCount(0)
  })

  test("a complex HTML library starter becomes one portable agent handoff", async ({
    owner: page,
  }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    const source = await publishArtifact(
      page,
      "launch-command-center.html",
      `<!doctype html><html><body>
        <main><h1>Launch command center</h1><p id="brief">{{brief}}</p>
        <output id="interaction">Interactions paused</output></main>
        <script>document.getElementById("interaction").textContent = "Interactions running"</script>
      </body></html>`,
      "text/html",
    )
    const { libraryId, entryId } = await addWorkspaceStarter(page, source)
    await page.goto(`/templates?tab=libraries&library=${libraryId}`)
    await page.getByTestId(`template-library-use-${entryId}`).click()
    await expect(
      page.getByRole("heading", { name: "Make Launch command center yours" }),
    ).toBeVisible()
    await expect(page.getByTestId("template-agent-brief")).toBeVisible()
    await expect(page.getByTestId("artifact-source-editor")).toHaveCount(0)
    await page
      .getByTestId("template-agent-brief")
      .fill("Align the November launch around customer evidence and one accountable owner.")
    await page.getByTestId("template-agent-copy").click()
    const handoff = await page.evaluate(() => navigator.clipboard.readText())
    expect(handoff).toContain(`derive://template-libraries/${libraryId}/${entryId}`)
    expect(handoff).toContain("November launch")
    expect(handoff).toContain("interactions")
    expect(new URL(page.url()).pathname).toBe("/templates")
  })

  test("a Context template prepares a portable context-builder handoff", async ({
    owner: page,
  }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    await page.goto("/templates?tab=contexts")
    await page.getByTestId("template-use-weekly-research-context").click()
    await expect(page.getByTestId("artifact-source-editor")).toHaveCount(0)
    await page
      .getByTestId("template-agent-brief")
      .fill("Track template ecosystems from approved product research every Monday at 9am.")
    await page.getByTestId("template-agent-copy").click()
    const handoff = await page.evaluate(() => navigator.clipboard.readText())
    expect(handoff).toContain("derive://templates/weekly-research-context")
    expect(handoff).toContain("automate with create_context")
    expect(handoff).toContain("every Monday at 9am")
  })
})

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
  test("choosing a template starts a natural-language agent job, not an editor", async ({
    owner: page,
  }) => {
    let openedBody: Record<string, unknown> | null = null
    await page.route("**/v1/chat-session", async (route) => {
      openedBody = route.request().postDataJSON() as Record<string, unknown>
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ session: { id: "ses_template_handoff" }, messages: [] }),
      })
    })
    await page.goto("/templates")
    await page.getByTestId("template-card-narrative-pitch").click()
    await page.getByTestId("template-use").click()

    await expect(page.getByRole("heading", { name: "Make Narrative pitch yours" })).toBeVisible()
    await expect(page.getByText("not an empty form to fill in")).toBeVisible()
    await expect(page.getByTestId("artifact-source-editor")).toHaveCount(0)
    await page
      .getByTestId("template-agent-brief")
      .fill("A customer-onboarding story for Acme’s product and success leaders.")
    await page.getByTestId("template-agent-go").click()

    await expect(page).toHaveURL(/\/chat\?session=ses_template_handoff/)
    const url = new URL(page.url())
    expect([...url.searchParams.keys()]).toEqual(["session"])
    expect(JSON.stringify(openedBody)).toContain("derive://templates/narrative-pitch")
    expect(JSON.stringify(openedBody)).toContain("customer-onboarding story")
    await expect(page.getByTestId("chat-page")).toBeVisible()
    await expect(page.getByText("derive://templates/narrative-pitch")).toHaveCount(0)
  })

  test("any existing artifact can become an agentic starting point", async ({ owner: page }) => {
    const source = await publishArtifact(
      page,
      "customer-proof.html",
      "<main><h1>Customer proof</h1><p>24 teams reached value in one day.</p></main>",
      "text/html",
    )
    let openedBody: Record<string, unknown> | null = null
    await page.route("**/v1/chat-session", async (route) => {
      openedBody = route.request().postDataJSON() as Record<string, unknown>
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ session: { id: "ses_artifact_handoff" }, messages: [] }),
      })
    })
    await page.goto("/templates?derive=true")
    await page.getByTestId("template-source-input").fill(source)
    await page.getByTestId("template-source-submit").click()

    await expect(page.getByRole("heading", { name: "Make customer-proof yours" })).toBeVisible()
    await page
      .getByTestId("template-agent-brief")
      .fill("Turn this evidence into a concise launch page for operations leaders.")
    await page.getByTestId("template-agent-go").click()
    await expect(page).toHaveURL(/\/chat\?session=ses_artifact_handoff/)
    const url = new URL(page.url())
    expect(url.pathname).toBe("/chat")
    expect(url.searchParams.get("session")).toBe("ses_artifact_handoff")
    expect([...url.searchParams.keys()]).toEqual(["session"])
    expect(JSON.stringify(openedBody)).toContain(source)
    expect(JSON.stringify(openedBody)).toContain("Turn this evidence")
  })

  test("the mobile card exposes its agent action without scrolling to the detail rail", async ({
    owner: page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto("/templates")
    const firstCard = page.getByTestId("template-card-narrative-pitch")
    await expect(firstCard).toBeInViewport()
    await expect(
      firstCard.locator("..").getByRole("button", { name: "Make it mine" }),
    ).toBeVisible()
  })

  test("a failed agent start keeps the brief private and recoverable in the dialog", async ({
    owner: page,
  }) => {
    await page.route("**/v1/chat-session", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "No model is configured for this workspace." }),
      }),
    )
    await page.goto("/templates")
    await page.getByTestId("template-use").click()
    const brief = "Confidential launch plan for the October partner rollout."
    await page.getByTestId("template-agent-brief").fill(brief)
    await page.getByTestId("template-agent-go").click()

    await expect(page.getByTestId("template-agent-error")).toContainText("No model")
    await expect(page.getByTestId("template-agent-brief")).toHaveValue(brief)
    expect(new URL(page.url()).pathname).toBe("/templates")
    expect(page.url()).not.toContain("Confidential")
    expect(page.url()).not.toContain("derive%3A")
  })

  test("an in-flight template job cannot be dismissed or double-submitted", async ({
    owner: page,
  }) => {
    let requests = 0
    await page.route("**/v1/chat-session", async (route) => {
      requests++
      await new Promise((resolve) => setTimeout(resolve, 350))
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ session: { id: "ses_slow_template" }, messages: [] }),
      })
    })
    await page.goto("/templates")
    await page.getByTestId("template-use").click()
    await page.getByTestId("template-agent-brief").fill("Make this specific to Acme.")
    await page.getByTestId("template-agent-go").click()
    await page.keyboard.press("Escape")

    await expect(page.getByRole("heading", { name: "Make Narrative pitch yours" })).toBeVisible()
    await expect(page.getByTestId("template-agent-go")).toBeDisabled()
    await page.getByTestId("template-agent-go").click({ force: true })
    await expect(page).toHaveURL(/\/chat\?session=ses_slow_template/)
    expect(requests).toBe(1)
  })

  test("a legacy deck link resumes the same agent-first flow without exposing source", async ({
    owner: page,
  }) => {
    await page.goto("/new?template=narrative-pitch")
    await expect(page).toHaveURL(/\/templates\?use=narrative-pitch/)
    await expect(page.getByRole("heading", { name: "Make Narrative pitch yours" })).toBeVisible()
    await expect(page.getByTestId("artifact-source-editor")).toHaveCount(0)
  })

  test("a complex HTML library starter is handed to the agent as one natural-language job", async ({
    owner: page,
  }) => {
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
    let openedBody: Record<string, unknown> | null = null
    await page.route("**/v1/chat-session", async (route) => {
      openedBody = route.request().postDataJSON() as Record<string, unknown>
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ session: { id: "ses_complex_html" }, messages: [] }),
      })
    })
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
    await page.getByTestId("template-agent-go").click()
    await expect(page).toHaveURL(/\/chat\?session=ses_complex_html/)
    expect(JSON.stringify(openedBody)).toContain(
      `derive://template-libraries/${libraryId}/${entryId}`,
    )
    expect(JSON.stringify(openedBody)).toContain("November launch")
  })

  test("a Context template starts a context-builder agent job", async ({ owner: page }) => {
    let openedBody: Record<string, unknown> | null = null
    await page.route("**/v1/chat-session", async (route) => {
      openedBody = route.request().postDataJSON() as Record<string, unknown>
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ session: { id: "ses_context_template" }, messages: [] }),
      })
    })
    await page.goto("/templates?tab=contexts")
    await page.getByTestId("template-card-weekly-research-context").click()
    await page.getByTestId("template-use").click()
    await expect(page.getByTestId("artifact-source-editor")).toHaveCount(0)
    await page
      .getByTestId("template-agent-brief")
      .fill("Track template ecosystems from approved product research every Monday at 9am.")
    await page.getByTestId("template-agent-go").click()
    await expect(page).toHaveURL(/\/chat\?session=ses_context_template/)
    expect(openedBody).toMatchObject({ purpose: "context_builder" })
    expect(JSON.stringify(openedBody)).toContain("weekly-research-context")
  })
})

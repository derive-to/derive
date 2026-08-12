import type { Page } from "@playwright/test"
import { expect, publishArtifact, test } from "./fixtures"

async function openBuiltInPreview(
  page: Page,
  id: string,
  tab: "artifacts" | "contexts" = "artifacts",
) {
  await page.goto(`/new?template=${id}${tab === "contexts" ? "&next=context" : ""}`)
}

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

  test("a built-in deck is briefed, previewed, and published without exposing source", async ({
    owner: page,
  }) => {
    await openBuiltInPreview(page, "narrative-pitch")
    await page.getByTestId("template-brief-input-audience").fill("Product and GTM leaders")
    await page.getByTestId("template-brief-input-objective").fill("Commit to the October launch")
    await page
      .getByTestId("template-brief-input-evidence")
      .fill("24 design partners and $2.4M pipeline")
    await page.getByTestId("template-start-brief-continue").click()

    await expect(page.getByTestId("artifact-source-editor")).toHaveCount(0)
    await expect(page.getByTestId("artifact-commit-message")).toHaveCount(0)
    await expect(page.getByTestId("template-adjust-brief")).toBeVisible()
    const preview = page.frameLocator('[data-testid="artifact-preview"]')
    await expect(preview.getByText("Product and GTM leaders")).toBeVisible()
    await expect(
      preview.getByRole("paragraph").filter({ hasText: "Commit to the October launch" }),
    ).toBeVisible()
    await expect(preview.getByText("24 design partners and $2.4M pipeline")).toBeVisible()

    await page.getByTestId("artifact-publish-version").click()
    await expect(page).toHaveURL(/\/artifacts\//)
    await expect(page.getByTestId("deck-position")).toHaveText("1 / 6")
  })

  test("required inputs can be previewed but cannot be bypassed at publish", async ({
    owner: page,
  }) => {
    await openBuiltInPreview(page, "narrative-pitch")
    await page.getByTestId("template-brief-skip").click()
    await expect(page.getByTestId("artifact-source-editor")).toHaveCount(0)
    await page.getByTestId("artifact-publish-version").click()
    await expect(page.getByRole("heading", { name: "Set the starting brief" })).toBeVisible()
    await expect(page.getByText(/Add Audience and Objective before publishing/)).toBeVisible()
  })

  test("a complex HTML library starter stays visual, inert by default, adjustable, and publishable", async ({
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
    await page.goto(`/templates?tab=libraries&library=${libraryId}`)
    await page.getByTestId(`template-library-use-${entryId}`).click()
    await expect(
      page.getByRole("heading", { name: "Make Launch command center yours" }),
    ).toBeVisible()
    await expect(page.getByTestId("template-agent-brief")).toBeVisible()
    await expect(page.getByTestId("artifact-source-editor")).toHaveCount(0)
    await page.keyboard.press("Escape")

    await page.goto(`/new?library=${libraryId}&entry=${entryId}`)
    await page
      .getByTestId("template-brief-input-brief")
      .fill("Coordinate proof, partner readiness, and blocker owners.")
    await page.getByTestId("template-start-brief-continue").click()

    await expect(page.getByTestId("artifact-source-editor")).toHaveCount(0)
    await expect(page.getByTestId("artifact-commit-message")).toHaveCount(0)
    const preview = page.frameLocator('[data-testid="artifact-preview"]')
    await expect(
      preview.getByText("Coordinate proof, partner readiness, and blocker owners."),
    ).toBeVisible()
    await expect(preview.getByText("Interactions paused")).toBeVisible()

    await page.getByTestId("template-preview-enable").click()
    await expect(preview.getByText("Interactions running")).toBeVisible()

    await page.getByTestId("template-adjust-brief").click()
    await page
      .getByTestId("template-brief-input-brief")
      .fill("Align the November launch around customer evidence and one accountable owner.")
    await page.getByTestId("template-start-brief-continue").click()
    await expect(
      preview.getByText(
        "Align the November launch around customer evidence and one accountable owner.",
      ),
    ).toBeVisible()
    await expect(preview.getByText(/\{\{brief\}\}/)).toHaveCount(0)

    await page.getByTestId("artifact-publish-version").click()
    await expect(page).toHaveURL(/\/artifacts\//)
    await expect(page.getByRole("heading", { name: "Launch command center" })).toBeVisible()
  })

  test("a Context template publishes its safe manifest into Context setup", async ({
    owner: page,
  }) => {
    await openBuiltInPreview(page, "weekly-research-context", "contexts")
    await page.getByTestId("template-brief-input-topic").fill("Template ecosystems")
    await page.getByTestId("template-brief-input-sources").fill("Approved product research")
    await page.getByTestId("template-brief-input-cadence").fill("Monday at 9am")
    await page.getByTestId("template-start-brief-continue").click()

    await expect(page.getByTestId("artifact-source-editor")).toHaveCount(0)
    const preview = page.frameLocator('[data-testid="artifact-preview"]')
    await expect(preview.getByText("Template ecosystems")).toBeVisible()
    await expect(preview.getByText("Approved product research")).toBeVisible()
    await expect(preview.getByText("Monday at 9am")).toBeVisible()

    await page.getByTestId("artifact-publish-version").click()
    await expect(page).toHaveURL(/\/contexts\?.*manifest=/)
  })
})

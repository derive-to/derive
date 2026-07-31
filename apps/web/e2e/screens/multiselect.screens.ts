import { test } from "../fixtures"
import { publishArtifact } from "../helpers"

// Capture-only, not a gate: seeds a library, drives the multi-select bar into a few
// states, and screenshots them for the walkthrough. Gated on SHOTS=1 like the other
// screens specs so a bare `playwright test` skips it. Output lands in ~/Projects/screenshots.
const OUT = `${process.env.HOME}/Projects/screenshots/library-multiselect`
const run = process.env.SHOTS === "1"

async function seed(page: Parameters<typeof publishArtifact>[0], titles: string[]) {
  const ids: string[] = []
  for (const t of titles) ids.push(await publishArtifact(page, `${t}.md`, `# ${t}\n\nbody`))
  await page.goto("/")
  for (const id of ids) await page.getByTestId(`artifact-card-open-${id}`).waitFor()
  return ids
}

test.describe("multiselect screens", () => {
  test.skip(!run, "SHOTS=1 to capture")

  test("desktop — bar over a selection (light + dark)", async ({ owner }) => {
    await owner.setViewportSize({ width: 1280, height: 900 })
    const ids = await seed(owner, ["Q3 Roadmap", "Launch Brief", "Retro Notes", "API Spec"])
    await owner.getByTestId(`artifact-card-select-${ids[0]}`).click()
    await owner.getByTestId(`artifact-card-select-${ids[1]}`).click()
    await owner.getByTestId(`artifact-card-select-${ids[2]}`).click()
    await owner.getByTestId("library-selection-bar").waitFor()
    await owner.screenshot({ path: `${OUT}/desktop-light.png` })

    await owner.getByTestId("user-menu-trigger").click()
    await owner.getByTestId("theme-option-dark").click()
    await owner.locator("html.dark").waitFor()
    await owner.keyboard.press("Escape")
    await owner.screenshot({ path: `${OUT}/desktop-dark.png` })
  })

  test("mobile — checkboxes + collapsed bar", async ({ owner }) => {
    await owner.setViewportSize({ width: 390, height: 844 })
    const ids = await seed(owner, ["Q3 Roadmap", "Launch Brief", "Retro Notes"])
    await owner.getByTestId(`artifact-card-select-${ids[0]}`).click()
    await owner.getByTestId(`artifact-card-select-${ids[1]}`).click()
    await owner.getByTestId("library-selection-bar").waitFor()
    await owner.screenshot({ path: `${OUT}/mobile-light.png` })
  })
})

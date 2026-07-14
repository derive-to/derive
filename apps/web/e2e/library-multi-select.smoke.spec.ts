import { expect, publishArtifact, test } from "./fixtures"

/**
 * Library multi-select: check some cards, act on the set from the floating bar.
 *
 * The bar writes through the SAME per-artifact endpoints the ⋯ menu uses, so the
 * assertions here deliberately end at the API, not at the toast — a green toast only
 * proves the client thinks it worked. Each bulk test reads the state back over HTTP and
 * checks the write actually landed on every artifact in the set.
 *
 * The mobile block is not a duplicate of the desktop one: it pins the two things that a
 * hover-built selection UI gets wrong on a phone — a checkbox that only appears on hover
 * (there is no hover), and a four-action bar that silently overflows a 375px viewport.
 */

// Publish n artifacts and land on the library with all of them on screen.
async function seedLibrary(page: Parameters<typeof publishArtifact>[0], n: number) {
  const ids: string[] = []
  for (let i = 1; i <= n; i++) {
    ids.push(await publishArtifact(page, `doc-${i}.md`, `# Doc ${i}\n\nbody`))
  }
  await page.goto("/")
  for (const id of ids) {
    await expect(page.getByTestId(`artifact-card-open-${id}`)).toBeVisible()
  }
  return ids
}

test("select cards, tag the set, and the tags land on every artifact", async ({ owner }) => {
  const [a, b, c] = await seedLibrary(owner, 3)

  // No selection, no bar — the library is a gallery until you say otherwise.
  await expect(owner.getByTestId("library-selection-bar")).toBeHidden()

  await owner.getByTestId(`artifact-card-select-${a}`).click()
  await owner.getByTestId(`artifact-card-select-${b}`).click()

  await expect(owner.getByTestId("library-selection-bar")).toBeVisible()
  await expect(owner.getByTestId("library-selection-count")).toHaveText("2")

  await owner.getByTestId("library-selection-tags").click()
  await owner.getByTestId("bulk-tag-input").fill("q3")
  await owner.getByTestId("bulk-tag-stage").click()
  await owner.getByTestId("bulk-tag-apply").click()

  await expect(owner.getByText("Tagged 2 artifacts")).toBeVisible()
  // The write cleared the selection, so the bar retires on its own.
  await expect(owner.getByTestId("library-selection-bar")).toBeHidden()

  // The real assertion: the server says both artifacts carry the tag, and the third —
  // never selected — was not touched.
  for (const id of [a, b]) {
    const res = await owner.request.get(`/v1/artifacts/${id}`)
    expect(res.ok()).toBeTruthy()
    expect(((await res.json()) as { tags: string[] }).tags).toContain("q3")
  }
  const untouched = await owner.request.get(`/v1/artifacts/${c}`)
  expect(((await untouched.json()) as { tags: string[] }).tags).not.toContain("q3")
})

test("tagging a set MERGES — it never replaces the tags an artifact already has", async ({
  owner,
}) => {
  const [a] = await seedLibrary(owner, 2)
  // Pre-existing tag, set the way the single-artifact dialog would.
  await owner.request.put(`/v1/artifacts/${a}/tags`, { data: { tags: ["keepme"] } })
  await owner.reload()

  await owner.getByTestId(`artifact-card-select-${a}`).click()
  await owner.getByTestId("library-selection-tags").click()
  await owner.getByTestId("bulk-tag-input").fill("added")
  await owner.getByTestId("bulk-tag-stage").click()
  await owner.getByTestId("bulk-tag-apply").click()
  await expect(owner.getByText("Tagged 1 artifact")).toBeVisible()

  // Both, not just the new one — the bulk path unions against each artifact's own set.
  const tags = (await (await owner.request.get(`/v1/artifacts/${a}`)).json()) as { tags: string[] }
  expect(tags.tags.sort()).toEqual(["added", "keepme"])
})

test("shift-click selects the range between two cards", async ({ owner }) => {
  const [a, , c] = await seedLibrary(owner, 3)

  await owner.getByTestId(`artifact-card-select-${a}`).click()
  await owner.getByTestId(`artifact-card-select-${c}`).click({ modifiers: ["Shift"] })

  // a through c inclusive — the card in the middle came along without being clicked.
  await expect(owner.getByTestId("library-selection-count")).toHaveText("3")
})

test("Escape clears the selection", async ({ owner }) => {
  const [a] = await seedLibrary(owner, 2)
  await owner.getByTestId(`artifact-card-select-${a}`).click()
  await expect(owner.getByTestId("library-selection-bar")).toBeVisible()

  await owner.keyboard.press("Escape")
  await expect(owner.getByTestId("library-selection-bar")).toBeHidden()
})

test("add a set to a new collection, created from the bar", async ({ owner }) => {
  const [a, b] = await seedLibrary(owner, 3)

  await owner.getByTestId(`artifact-card-select-${a}`).click()
  await owner.getByTestId(`artifact-card-select-${b}`).click()
  await owner.getByTestId("library-selection-collections").click()

  await owner.getByTestId("bulk-collection-new-input").fill("Q3 Research")
  await owner.getByTestId("bulk-collection-create").click()
  await owner.getByTestId("bulk-collection-apply").click()
  await expect(owner.getByText("Added 2 artifacts")).toBeVisible()

  // Read the membership back off the server: the collection holds exactly the two.
  const cols = (await (await owner.request.get("/v1/collections")).json()) as {
    collections: { id: string; title: string }[]
  }
  const col = cols.collections.find((x) => x.title === "Q3 Research")
  expect(col, "the collection was created").toBeTruthy()
  const listed = (await (
    await owner.request.get(`/v1/artifacts?collection=${col?.id}`)
  ).json()) as { artifacts: { short_id: string }[] }
  expect(listed.artifacts.map((x) => x.short_id).sort()).toEqual([a, b].sort())
})

test("star a set from the bar, then unstar it", async ({ owner }) => {
  const [a, b] = await seedLibrary(owner, 2)

  await owner.getByTestId(`artifact-card-select-${a}`).click()
  await owner.getByTestId(`artifact-card-select-${b}`).click()
  await owner.getByTestId("library-selection-favorite").click()
  await expect(owner.getByText("Starred 2 artifacts")).toBeVisible()

  // Favorites is its own feed — both land there.
  await owner.goto("/favorites")
  await expect(owner.getByTestId(`artifact-card-open-${a}`)).toBeVisible()
  await expect(owner.getByTestId(`artifact-card-open-${b}`)).toBeVisible()

  // Re-select in the favorites feed: every card is already starred, so the action
  // inverts to Unstar.
  await owner.getByTestId(`artifact-card-select-${a}`).click()
  await owner.getByTestId(`artifact-card-select-${b}`).click()
  await expect(owner.getByTestId("library-selection-favorite")).toHaveAttribute(
    "aria-label",
    "Unstar",
  )
  await owner.getByTestId("library-selection-favorite").click()
  await expect(owner.getByText("Unstarred 2 artifacts")).toBeVisible()
  await expect(owner.getByTestId(`artifact-card-open-${a}`)).toBeHidden()
})

test("deleting a set asks first, then removes them", async ({ owner }) => {
  const [a, b, c] = await seedLibrary(owner, 3)

  await owner.getByTestId(`artifact-card-select-${a}`).click()
  await owner.getByTestId(`artifact-card-select-${b}`).click()
  await owner.getByTestId("library-selection-delete").click()

  // Destructive, so it goes through the shared confirm — never a bare bulk button.
  await expect(owner.getByText("Delete 2 artifacts?")).toBeVisible()
  await owner.getByTestId("library-selection-delete-confirm").click()
  await expect(owner.getByText("Deleted 2 artifacts")).toBeVisible()

  await expect(owner.getByTestId(`artifact-card-open-${a}`)).toBeHidden()
  await expect(owner.getByTestId(`artifact-card-open-${b}`)).toBeHidden()
  // The one we never checked survives.
  await expect(owner.getByTestId(`artifact-card-open-${c}`)).toBeVisible()
})

test("changing the feed drops the selection instead of carrying it off-screen", async ({
  owner,
}) => {
  const [a] = await seedLibrary(owner, 2)
  await owner.getByTestId(`artifact-card-select-${a}`).click()
  await expect(owner.getByTestId("library-selection-bar")).toBeVisible()

  // Switch to the "Created by me" tab — a different feed, so the set resets rather than
  // leaving the bar counting artifacts the new feed may not even contain.
  await owner.getByTestId("library-tab-mine").click()
  await expect(owner.getByTestId("library-selection-bar")).toBeHidden()
})

// The phone. A selection UI built around hover and a four-action bar are exactly the two
// things that break here, so both are asserted directly rather than inferred from a click
// that would have "passed" against an invisible control (Playwright clicks opacity-0
// elements happily — hence the explicit computed-opacity check).
test.describe("mobile", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true })

  test("checkboxes are visible without hover, and the bar fits the viewport", async ({ owner }) => {
    const [a, b] = await seedLibrary(owner, 3)

    // On a touch pointer the checkbox is pinned visible: there is no hover to reveal it.
    const box = owner.getByTestId(`artifact-card-select-${a}`)
    await expect(box).toHaveCSS("opacity", "1")

    await box.tap()
    await owner.getByTestId(`artifact-card-select-${b}`).tap()
    const bar = owner.getByTestId("library-selection-bar")
    await expect(bar).toBeVisible()
    await expect(owner.getByTestId("library-selection-count")).toHaveText("2")

    // The bar fits inside the phone, and the page never gains a horizontal scrollbar.
    const width = (await bar.boundingBox())?.width ?? 0
    expect(width).toBeGreaterThan(0)
    expect(width).toBeLessThanOrEqual(375)
    const overflows = await owner.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    expect(overflows, "the library must not scroll horizontally").toBe(false)

    // All four actions are reachable — they collapse to icons, they don't disappear into
    // an overflow menu.
    for (const id of ["tags", "collections", "favorite", "delete"]) {
      await expect(owner.getByTestId(`library-selection-${id}`)).toBeVisible()
    }
  })

  test("the full tag flow works on a phone", async ({ owner }) => {
    const [a, b] = await seedLibrary(owner, 2)

    await owner.getByTestId(`artifact-card-select-${a}`).tap()
    await owner.getByTestId(`artifact-card-select-${b}`).tap()
    await owner.getByTestId("library-selection-tags").tap()
    await owner.getByTestId("bulk-tag-input").fill("mobile")
    await owner.getByTestId("bulk-tag-stage").tap()
    await owner.getByTestId("bulk-tag-apply").tap()

    await expect(owner.getByText("Tagged 2 artifacts")).toBeVisible()
    for (const id of [a, b]) {
      const res = await owner.request.get(`/v1/artifacts/${id}`)
      expect(((await res.json()) as { tags: string[] }).tags).toContain("mobile")
    }
  })
})

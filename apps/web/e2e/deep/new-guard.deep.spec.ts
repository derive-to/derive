import { expect, test } from "../fixtures"

// The /new unsaved-draft guard, both directions: publishing must NAV to the artifact (the
// guard bypasses its own save nav), while Cancel with a dirty draft must BLOCK. Regression
// guard for the ref-vs-state race — a batched state flag would have fired the discard
// dialog on the publish path itself, so this pins the ref-based bypass in place.
test("publishing from /new navigates to the artifact, not the discard guard", async ({ owner }) => {
  const p = owner
  await p.goto("/new")
  await p.getByTestId("artifact-source-editor").click()
  await p.keyboard.type("# Publish me\n\nReal content.")
  await p.getByTestId("artifact-title-input").fill("Publish me")
  await p.getByTestId("artifact-publish-version").click()

  // The save nav is allowed: we land on the artifact, and the discard dialog never shows.
  await expect(p).toHaveURL(/\/artifacts\//, { timeout: 15_000 })
  await expect(p.getByTestId("new-discard-confirm")).toHaveCount(0)
})

test("leaving /new with an unsaved draft blocks with the discard guard", async ({ owner }) => {
  const p = owner
  await p.goto("/new")
  await p.getByTestId("artifact-source-editor").click()
  await p.keyboard.type("# Draft\n\nUnsaved.")
  await p.getByTestId("artifact-edit-cancel").click()

  // The guard intercepts the departure.
  await expect(p.getByTestId("new-discard-confirm")).toBeVisible()
  // Keeping (cancel the dialog) stays on /new with the draft intact.
  await p.getByTestId("confirm-dialog-cancel").click()
  await expect(p).toHaveURL(/\/new/)
  await expect(p.getByTestId("artifact-publish-version")).toBeVisible()
})

// An untouched /new (no input) must NOT block — leaving is free.
test("leaving an untouched /new does not block", async ({ owner }) => {
  const p = owner
  await p.goto("/new")
  await p.getByTestId("artifact-edit-cancel").click()
  await expect(p).toHaveURL(/\/(?!new)/, { timeout: 10_000 })
  await expect(p.getByTestId("new-discard-confirm")).toHaveCount(0)
})

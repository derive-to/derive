import { expect, test } from "../fixtures"

// Visual + render check for the "Pull request previews" group in the GitHub settings
// tab. The data is mocked at the API boundary (PR previews are webhook-created, not
// user-creatable), so this drives the REAL component with realistic state — one synced
// preview, one mid-sync — to confirm it renders and looks right.

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

const SYNC_PAYLOAD = {
  app: { configured: true, slug: "derive-acme" },
  installations: [{ installation_id: "1", account_login: "acme" }],
  sources: [
    {
      id: "rs1",
      collection_id: "c1",
      repo: "acme/handbook",
      ref: "HEAD",
      includes: "**/*.md,**/*.html",
      token: null,
      installation_id: "1",
      last_synced_at: iso(4 * 60_000),
      last_status: "ok",
      created_by: "u1",
      created_at: iso(86_400_000),
      file_count: 42,
      progress: null,
    },
  ],
  prs: [
    {
      id: "pr1",
      collection_id: "cp1",
      repo: "acme/handbook",
      pr_number: 128,
      title: "PR #128: Add the billing & invoicing plan",
      last_status: "ok",
      last_synced_at: iso(6 * 60_000),
      file_count: 3,
      progress: null,
    },
    {
      id: "pr2",
      collection_id: "cp2",
      repo: "acme/handbook",
      pr_number: 131,
      title: "PR #131: Restructure the onboarding guide",
      last_status: null,
      last_synced_at: null,
      file_count: 0,
      progress: JSON.stringify({ phase: "mirroring", done: 2, total: 5, updatedAt: iso(1000) }),
    },
  ],
}

test("PR previews render in the GitHub settings tab", async ({ owner }) => {
  await owner.route("**/v1/sync/github", async (route) => {
    if (route.request().method() !== "GET") return route.fallback()
    await route.fulfill({ json: SYNC_PAYLOAD })
  })

  await owner.goto("/settings/github")

  await expect(owner.getByText("Pull request previews")).toBeVisible()
  // Both previews render. The title drops the "PR #<n>:" prefix the API adds; the
  // number rides the GitHub link; "View" opens the mirrored collection.
  await expect(owner.getByTestId("github-pr-128")).toContainText("Add the billing & invoicing plan")
  await expect(owner.getByTestId("github-pr-128")).not.toContainText("PR #128:")
  await expect(owner.getByTestId("github-pr-131")).toBeVisible()
  await expect(owner.getByTestId("github-pr-link-128")).toHaveAttribute(
    "href",
    "https://github.com/acme/handbook/pull/128",
  )
  await expect(owner.getByTestId("github-pr-view-131")).toBeVisible()
})

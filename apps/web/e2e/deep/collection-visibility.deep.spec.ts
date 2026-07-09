import { Buffer } from "node:buffer"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { expect, signUp, test } from "../fixtures"

// End-to-end proof for the collection visibility + owner-protection fix, driven
// through the real web UI (real API, real Better Auth). Reproduces the exact
// scenarios from the bug reports and captures screenshots into
// ~/Projects/screenshots/derive-collections. Companion to the API/store coverage
// in apps/api/test/collection-access.test.ts + packages/db/test/store-contract.ts.
//
// Cast, all in ANA's workspace (multi-workspace mode gives each signup its own):
//  • ana  — creator/owner of the collection.
//  • ben  — a workspace EDITOR seat, NOT an explicit collection member. He is the
//           whole point: seat-only reach used to render "· 1" over an empty body.
//  • cara — a workspace member promoted to collection OWNER (a manager), used to
//           show a non-creator manager still can't touch the creator's row.

const SHOTS = join(homedir(), "Projects/screenshots/derive-collections")

test("collection visibility + owner protection, end to end", async ({
  owner: ana,
  secondUser: ben,
  browser,
}) => {
  mkdirSync(SHOTS, { recursive: true })
  const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) })

  // --- ana's workspace id (so teammates can switch into it) ---
  const anaOrg = ((await (await ana.request.get("/v1/workspaces")).json()) as { active: string })
    .active

  // --- ana creates a workspace-open collection (the default) ---
  const col = (await (
    await ana.request.post("/v1/collections", { data: { title: "Product Training" } })
  ).json()) as { id: string; workspace_access: string }
  expect(col.workspace_access).toBe("member")

  // --- ana publishes a PRIVATE artifact and folds it into the collection. Private
  //     means the ONLY way a teammate reaches it is the collection itself. ---
  const priv = (await (
    await ana.request.post("/v1/artifacts", {
      multipart: {
        file: {
          name: "onboarding.md",
          mimeType: "text/markdown",
          buffer: Buffer.from("# Q3 Onboarding Playbook\n\nInternal, private.\n"),
        },
        title: "Q3 Onboarding Playbook",
        visibility: "private",
      },
    })
  ).json()) as { short_id: string }
  expect((await ana.request.put(`/v1/collections/${col.id}/items/${priv.short_id}`)).ok()).toBe(
    true,
  )

  // --- ben joins ana's workspace as an EDITOR seat (no explicit collection share) ---
  expect(
    (
      await ana.request.post("/v1/workspace/invites", {
        data: { email: ben.email, role: "editor" },
      })
    ).ok(),
  ).toBe(true)

  // --- cara joins the workspace as an editor seat now; she's promoted to
  //     collection OWNER later (just before S2), so S1 sees ana as the sole
  //     member and the creator-row assertion stays unambiguous. ---
  const caraCtx = await browser.newContext()
  const caraPage = await caraCtx.newPage()
  const caraEmail = await signUp(caraPage, "Cara")
  expect(
    (
      await ana.request.post("/v1/workspace/invites", {
        data: { email: caraEmail, role: "editor" },
      })
    ).ok(),
  ).toBe(true)

  // ============================================================================
  // S1 — the CREATOR's Share dialog: their own row is a fixed "Owner", no role
  //      dropdown and no remove control (fixes the self-downgrade screenshot).
  // ============================================================================
  await ana.goto(`/?collection=${col.id}`)
  await expect(ana.getByTestId("collection-share")).toBeVisible()
  await ana.getByTestId("collection-share").click()
  const anaDialog = ana.getByRole("dialog")
  await expect(anaDialog.getByText("Product Training", { exact: false })).toBeVisible()
  // Ana is the only member and she is the creator → zero editable controls.
  await expect(anaDialog.locator('[data-testid^="collection-share-member-role-"]')).toHaveCount(0)
  await expect(anaDialog.locator('[data-testid^="collection-share-remove-"]')).toHaveCount(0)
  await expect(anaDialog.getByText("Owner", { exact: true }).first()).toBeVisible()
  await shot(ana, "01-creator-dialog-owner-immovable")
  await ana.keyboard.press("Escape")

  // ============================================================================
  // S3 — a SEAT-ONLY member sees the private artifact (count matches the body),
  //      instead of "· 1" over "This collection is empty."
  // ============================================================================
  await ben.page.request.post("/v1/workspace/switch", { data: { id: anaOrg } })
  await ben.page.goto(`/?collection=${col.id}`)
  await expect(ben.page.getByText("Q3 Onboarding Playbook").first()).toBeVisible()
  await expect(ben.page.getByText("This collection is empty.")).toBeHidden()
  await shot(ben.page, "03-seat-member-sees-contents")

  // ============================================================================
  // S4 — the seat-only member can OPEN the private item (no 404): propagation
  //      reaches the read path, not just the listing.
  // ============================================================================
  await ben.page.goto(`/artifacts/${priv.short_id}`)
  await expect(ben.page.getByText("Q3 Onboarding Playbook").first()).toBeVisible()
  await shot(ben.page, "04-seat-member-opens-item")

  // ============================================================================
  // S2 — a MANAGER who is not the creator: the creator's row is a fixed "Owner"
  //      (no dropdown / no remove), while their own non-creator row stays
  //      editable — management still works, the creator is protected.
  // ============================================================================
  // Promote cara to collection owner so she can manage the roster.
  expect(
    (
      await ana.request.put(`/v1/collections/${col.id}/members`, {
        data: { email: caraEmail, role: "owner" },
      })
    ).ok(),
  ).toBe(true)
  await caraPage.request.post("/v1/workspace/switch", { data: { id: anaOrg } })
  await caraPage.goto(`/?collection=${col.id}`)
  await expect(caraPage.getByTestId("collection-share")).toBeVisible()
  await caraPage.getByTestId("collection-share").click()
  const caraDialog = caraPage.getByRole("dialog")
  await expect(caraDialog.getByText("Ana", { exact: false })).toBeVisible()
  // Exactly one editable row (cara's own); the creator (ana) row is fixed.
  await expect(caraDialog.locator('[data-testid^="collection-share-member-role-"]')).toHaveCount(1)
  await expect(caraDialog.locator('[data-testid^="collection-share-remove-"]')).toHaveCount(1)
  await shot(caraPage, "02-manager-view-creator-protected")
  await caraPage.keyboard.press("Escape")

  // ============================================================================
  // S5 — flipping the collection to Invited drops the seat member entirely:
  //      the artifact vanishes for ben (visibility stays consistent).
  // ============================================================================
  expect(
    (
      await ana.request.patch(`/v1/collections/${col.id}/access`, {
        data: { workspaceAccess: "none" },
      })
    ).ok(),
  ).toBe(true)
  await ben.page.goto(`/?collection=${col.id}`)
  await expect(ben.page.getByText("Q3 Onboarding Playbook")).toBeHidden()
  // And it's gone from his sidebar entirely — land on the library home (shell
  // settled) so the screenshot shows a stable "no Product Training" state.
  await ben.page.goto("/")
  await expect(ben.page.getByTestId("library-menu")).toBeVisible()
  await expect(ben.page.getByText("Product Training")).toBeHidden()
  await shot(ben.page, "05-invite-only-hides-from-seat-member")

  await caraCtx.close()
})

import { Buffer } from "node:buffer"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"

// End-to-end proof for the share dialog's collection-disclosure rows + the honest
// trigger glyph, driven through the real web UI. The bug being fixed: a fully
// private artifact inside a workspace-open collection is readable by every seat
// (collectionRolesForArtifact folds the grant in), but the Share dialog said
// "Invited" and the trigger wore a lock. Companion to the API coverage in
// apps/api/test/collection-access.test.ts ("collection_access disclosure…") and
// the UI-visibility coverage in collection-visibility.deep.spec.ts.
//
// Cast:
//  • ana — publishes a PRIVATE artifact, then files it into her workspace-open
//          "Product Training" collection (the Lucas scenario).
//  • ben — an editor seat, no explicit share anywhere: reaches the doc only
//          through the collection; his dialog must say who to ask ("Managed by").

const SHOTS = join(homedir(), "Projects/screenshots/derive-share-disclosure")

test("the share dialog discloses collection-propagated access, live", async ({
  owner: ana,
  secondUser: ben,
}) => {
  mkdirSync(SHOTS, { recursive: true })
  const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) })

  const anaOrg = ((await (await ana.request.get("/v1/workspaces")).json()) as { active: string })
    .active

  // --- ana publishes a PRIVATE artifact: no workspace seat, no link, unlisted. ---
  const priv = (await (
    await ana.request.post("/v1/artifacts", {
      multipart: {
        file: {
          name: "custom-offers.md",
          mimeType: "text/markdown",
          buffer: Buffer.from("# Custom Offers — Internal Enablement\n\nPrivate.\n"),
        },
        title: "Custom Offers — Internal Enablement",
        workspace_access: "none",
        link_role: "none",
        listed: "none",
      },
    })
  ).json()) as { short_id: string }

  // ============================================================================
  // S1 — before any collection: the trigger wears the LOCK and the dialog shows
  //      no disclosure section. The baseline the fix must not disturb.
  // ============================================================================
  await ana.goto(`/artifacts/${priv.short_id}`)
  const trigger = ana.getByTestId("share-trigger")
  await expect(trigger.locator("svg.lucide-lock")).toBeVisible()
  await trigger.click()
  const dialog = ana.getByRole("dialog")
  await expect(dialog.getByText("Reachable through collections")).toBeHidden()
  await expect(dialog.getByText("Only the people you add below can open this.")).toBeVisible()
  await shot(ana, "01-private-no-collection-lock")
  await ana.keyboard.press("Escape")

  // --- ana files it into a workspace-open collection (the default). ---
  const col = (await (
    await ana.request.post("/v1/collections", { data: { title: "Product Training" } })
  ).json()) as { id: string; workspace_access: string }
  expect(col.workspace_access).toBe("member")
  expect((await ana.request.put(`/v1/collections/${col.id}/items/${priv.short_id}`)).ok()).toBe(
    true,
  )

  // ============================================================================
  // S2 — the OWNER's dialog now tells the truth: share glyph on the trigger, a
  //      "Reachable through collections" row naming the collection and its reach,
  //      honest Invited copy, and a Manage affordance (she owns the collection).
  // ============================================================================
  await ana.goto(`/artifacts/${priv.short_id}`)
  await expect(trigger.locator("svg.lucide-share2")).toBeVisible()
  await trigger.click()
  await expect(dialog.getByText("Reachable through collections")).toBeVisible()
  const row = dialog.getByTestId(`share-collection-row-${col.id}`)
  await expect(row.getByText("Product Training")).toBeVisible()
  await expect(row.getByText("Everyone in the workspace opens this at their role")).toBeVisible()
  await expect(
    dialog.getByText("Only the people you add below — plus everyone reached through"),
  ).toBeVisible()
  await shot(ana, "02-owner-sees-disclosure-row")

  // ============================================================================
  // S3 — Manage opens the collection's own share dialog STACKED (no navigation);
  //      flipping it to Invited and closing refreshes the artifact dialog live:
  //      the row disappears (her solo invite-only collection adds no reach) and
  //      the trigger's lock promise is true again.
  // ============================================================================
  await dialog.getByTestId(`share-collection-manage-${col.id}`).click()
  const stacked = ana.getByRole("dialog").filter({ hasText: "every artifact" })
  await expect(stacked.getByText("Product Training", { exact: false })).toBeVisible()
  await ana.waitForTimeout(400) // let both fade-ins settle so the screenshot shows real layering
  await shot(ana, "03-manage-stacks-collection-dialog")
  await stacked.getByTestId("collection-share-access").getByText("Invited").click()
  await ana.keyboard.press("Escape") // close the stacked dialog → invalidate + refetch
  await expect(ana.getByText("Reachable through collections")).toBeHidden()
  await shot(ana, "04-invited-collection-row-gone")
  await ana.keyboard.press("Escape")
  await expect(trigger.locator("svg.lucide-lock")).toBeVisible()

  // Flip it back to workspace-open for ben's leg.
  expect(
    (
      await ana.request.patch(`/v1/collections/${col.id}/access`, {
        data: { workspaceAccess: "member" },
      })
    ).ok(),
  ).toBe(true)

  // ============================================================================
  // S4 — a SEAT-ONLY member reaches the private doc through the collection; his
  //      dialog shows the same row with ATTRIBUTION, not Manage — the lever
  //      belongs to ana and the row says so.
  // ============================================================================
  expect(
    (
      await ana.request.post("/v1/workspace/invites", {
        data: { email: ben.email, role: "editor" },
      })
    ).ok(),
  ).toBe(true)
  await ben.page.request.post("/v1/workspace/switch", { data: { id: anaOrg } })
  await ben.page.goto(`/artifacts/${priv.short_id}`)
  const benTrigger = ben.page.getByTestId("share-trigger")
  await expect(benTrigger.locator("svg.lucide-share2")).toBeVisible()
  await benTrigger.click()
  const benDialog = ben.page.getByRole("dialog")
  const benRow = benDialog.getByTestId(`share-collection-row-${col.id}`)
  await expect(benRow.getByText("Product Training")).toBeVisible()
  await expect(benRow.getByText(/Managed by/)).toBeVisible()
  await expect(benDialog.getByTestId(`share-collection-manage-${col.id}`)).toHaveCount(0)
  await shot(ben.page, "05-seat-member-attribution-no-manage")
})

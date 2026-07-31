import type { MembershipRecord, MetaStore } from "@derive/core"
import type { BillingDriver } from "./billing"
import { syncSeats } from "./seats"

// Account-deletion guard: the workspaces a user SOLELY owns that still have other members.
// Deleting the account would leave those workspaces without an admin, so we block until the
// user transfers ownership or removes the others. A personal / solo workspace (no other
// members) is fine — it's dropped by the deleteUserData cascade. Returns the blocking
// workspace names for a clear error message; empty ⇒ deletion is safe.
export async function workspacesBlockingDeletion(
  meta: MetaStore,
  userId: string,
): Promise<string[]> {
  const owned = (await meta.listWorkspaces(userId)).filter((ws) => ws.role === "owner")
  // Every owned workspace's members in ONE query, grouped by org — not a listMemberships
  // per workspace.
  const membersByOrg = new Map<string, MembershipRecord[]>()
  for (const m of await meta.listMembershipsForOrgs(owned.map((ws) => ws.id))) {
    const arr = membersByOrg.get(m.org_id)
    if (arr) arr.push(m)
    else membersByOrg.set(m.org_id, [m])
  }
  const blocking: string[] = []
  for (const ws of owned) {
    const others = (membersByOrg.get(ws.id) ?? []).filter((m) => m.user_id !== userId)
    // Solo workspace → fine. Others exist but at least one is also an owner → fine. Only
    // block when the leaving user is the LAST owner of a shared workspace.
    if (others.length > 0 && !others.some((m) => m.role === "owner")) blocking.push(ws.name)
  }
  return blocking
}

// Account deletion: purge the user's data, then heal Stripe seat counts.
//
// meta.deleteUserData drops the user's membership row in EVERY workspace they
// belonged to in one shot — including any workspace where they held a billable
// role (editor/owner). Left alone, Stripe keeps billing for that now-vacant seat
// until some unrelated membership change on that workspace happens to trigger
// syncSeats (a PUT/PATCH/DELETE on /v1/workspace/members, or the next GET
// /v1/billing heal) — which may be never, for a small team. So: capture the
// billable orgs BEFORE the purge (their membership rows won't exist to query
// afterward), run the purge, then push a recount to each affected org. Same
// fire-and-forget contract as every other syncSeats call site — a Stripe hiccup
// here must never surface as a failed account deletion.
export async function purgeUserDataAndSyncSeats(
  meta: MetaStore,
  billing: BillingDriver | undefined,
  userId: string,
): Promise<void> {
  const billableOrgs = (await meta.listWorkspaces(userId))
    .filter((ws) => ws.role === "editor" || ws.role === "owner")
    .map((ws) => ws.id)
  await meta.deleteUserData(userId)
  for (const orgId of billableOrgs) await syncSeats({ meta, billing }, orgId)
}

import type { MembershipRecord, MetaStore } from "@derive/core"
import type { BillingDriver } from "./billing"
import { isBillableRole, syncSeats } from "./seats"

// Account-deletion guard: workspaces where removing this person would strand either
// workspace administration or workspace-bound artifact/collection ownership. Better Auth's
// purge bypasses the ordinary member-removal route and deletes memberships + owner rows
// directly, so it must enforce the same handoff invariant here. Personal-workspace resources
// count too: deleteUserData removes that workspace's label, but intentionally preserves its
// artifacts. Returns blocking workspace names for a clear error message; empty ⇒ deletion
// is safe.
export async function workspacesBlockingDeletion(
  meta: MetaStore,
  userId: string,
): Promise<string[]> {
  const mine = await meta.listWorkspaces(userId)
  const owned = mine.filter((ws) => ws.role === "owner")
  // Every owned workspace's members in ONE query, grouped by org — not a listMemberships
  // per workspace.
  const membersByOrg = new Map<string, MembershipRecord[]>()
  for (const m of await meta.listMembershipsForOrgs(owned.map((ws) => ws.id))) {
    const arr = membersByOrg.get(m.org_id)
    if (arr) arr.push(m)
    else membersByOrg.set(m.org_id, [m])
  }
  const blocking = new Set<string>()
  for (const ws of owned) {
    const others = (membersByOrg.get(ws.id) ?? []).filter((m) => m.user_id !== userId)
    // Others exist but no other workspace owner → deleting this account removes the
    // workspace's last administrator. A solo non-personal workspace is handled by the
    // resource check below; when empty, leaving it ownerless is the existing behavior.
    if (others.length > 0 && !others.some((m) => m.role === "owner")) blocking.add(ws.name)
  }
  const resourceBlocks = await Promise.all(
    mine.map(async (ws) => {
      const resources = await meta.workspaceOwnershipBlockers(ws.id, userId)
      return { ws, blocked: resources.artifacts > 0 || resources.collections > 0 }
    }),
  )
  for (const { ws, blocked } of resourceBlocks) if (blocked) blocking.add(ws.name)
  return [...blocking]
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
    .filter((ws) => isBillableRole(ws.role))
    .map((ws) => ws.id)
  await meta.deleteUserData(userId)
  await Promise.all(billableOrgs.map((orgId) => syncSeats({ meta, billing }, orgId)))
}

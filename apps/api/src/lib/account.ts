import type { MetaStore } from "@derive/core"

// Account-deletion guard: the workspaces a user SOLELY owns that still have other members.
// Deleting the account would leave those workspaces without an admin, so we block until the
// user transfers ownership or removes the others. A personal / solo workspace (no other
// members) is fine — it's dropped by the deleteUserData cascade. Returns the blocking
// workspace names for a clear error message; empty ⇒ deletion is safe.
export async function workspacesBlockingDeletion(
  meta: MetaStore,
  userId: string,
): Promise<string[]> {
  const mine = await meta.listWorkspaces(userId)
  const blocking: string[] = []
  for (const ws of mine) {
    if (ws.role !== "owner") continue
    const members = await meta.listMemberships(ws.id)
    const others = members.filter((m) => m.user_id !== userId)
    // Solo workspace → fine. Others exist but at least one is also an owner → fine. Only
    // block when the leaving user is the LAST owner of a shared workspace.
    if (others.length > 0 && !others.some((m) => m.role === "owner")) blocking.push(ws.name)
  }
  return blocking
}

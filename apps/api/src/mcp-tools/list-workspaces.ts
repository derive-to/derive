import { type Role, roleAllows } from "@derive/core"
import type { ToolContext } from "../mcp-tool-context"
import { json } from "../mcp-util"

export function registerListWorkspacesTool(tc: ToolContext): void {
  const { server, grantedWorkspaces, defaultOrg, agent, actingFor, registered, scopeForCap } = tc
  server.registerTool(
    "list_workspaces",
    {
      description:
        "WHO AM I and WHERE can I act — this connection's identity (principal, acting-for human, the access it holds) plus every workspace the grant reaches: id, name, your role, the default, and what that role can't do. Pass a workspace's id or name as the `workspace` argument to find / read / catch_up / comment / publish to act there. No reconnect — read/catch_up/comment even find a short_id across these workspaces automatically.",
      inputSchema: {},
    },
    async () => {
      const mine = await grantedWorkspaces()
      // What a role CAN'T do is the actionable half: an agent that knows it is a
      // commenter here stops discovering that by attempting a publish and parsing the
      // refusal. Only gaps are listed — a row with nothing missing stays unremarkable.
      const gaps = (role: Role) =>
        (["comment", "publish", "manage"] as const).filter((a) => !roleAllows(role, a))
      const row = (id: string, name: string | null, role: Role) => ({
        id,
        name,
        role,
        default: id === defaultOrg,
        ...(gaps(role).length ? { cannot: gaps(role) } : {}),
      })
      const rows = mine.length
        ? mine.map((w) => row(w.id, w.name, w.role))
        : [row(defaultOrg, null, agent.role)]
      return json({
        // The identity block: what an agent would otherwise infer by trying things and
        // reading errors. `access` is the grant's own ceiling BEFORE each workspace's
        // membership caps it — which is why a row's role can be lower than this.
        me: {
          principal: registered ? "registered_agent" : actingFor ? "oauth_grant" : "static_token",
          name: agent.name,
          acting_for: actingFor ? (actingFor.name ?? actingFor.id) : null,
          access: scopeForCap,
          ...(registered
            ? {}
            : {
                note: "Reach REST from your shell at this same access with stage target:'api' (a short-lived bearer). If a workspace ROLE is the limit, an admin changes it; if `access` is the limit, re-consent with a wider scope.",
              }),
        },
        count: rows.length,
        workspaces: rows,
      })
    },
  )
}

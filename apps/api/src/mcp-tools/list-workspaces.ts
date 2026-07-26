import type { ToolContext } from "../mcp-tool-context"
import { json } from "../mcp-util"

export function registerListWorkspacesTool(tc: ToolContext): void {
  const { server, grantedWorkspaces, defaultOrg, agent } = tc
  server.registerTool(
    "list_workspaces",
    {
      description:
        "List every workspace THIS grant can act in — id, name, your role there, and which is your default (the set you chose when you connected: all your workspaces, or a subset). Pass a workspace's id or name as the `workspace` argument to find / read / catch_up / comment / publish to act there. No reconnect — read/catch_up/comment even find a short_id across these workspaces automatically.",
      inputSchema: {},
    },
    async () => {
      const mine = await grantedWorkspaces()
      const rows = mine.length
        ? mine.map((w) => ({ id: w.id, name: w.name, role: w.role, default: w.id === defaultOrg }))
        : [{ id: defaultOrg, name: null as string | null, role: agent.role, default: true }]
      return json({ count: rows.length, workspaces: rows })
    },
  )
}

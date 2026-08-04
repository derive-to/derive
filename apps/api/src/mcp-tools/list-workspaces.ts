import { type Role, roleAllows } from "@derive/core"
import type { ToolContext } from "../mcp-tool-context"
import { json } from "../mcp-util"

export function registerListWorkspacesTool(
  tc: ToolContext,
  /** The server's LIVE tool names, read at call time. Compare against what your client
   *  shows: a mismatch means the connection cached an older surface and must reconnect
   *  to reach anything added since — the failure this makes diagnosable instead of
   *  indistinguishable from a feature that doesn't exist. */
  liveTools?: () => string[],
): void {
  const { server, grantedWorkspaces, defaultOrg, agent, actingFor, registered, scopeForCap } = tc
  const { mintedToken } = tc
  server.registerTool(
    "list_workspaces",
    {
      description:
        "WHO AM I and WHERE can I act — this connection's identity (principal, acting-for human, the access it holds) plus every workspace the grant reaches: id, name, your role, the default, and what that role can't do. Pass a workspace's id or name as the `workspace` argument to find / read / catch_up / comment / publish to act there. No reconnect — read/catch_up/comment even find a short_id across these workspaces automatically.",
      annotations: {
        title: "List workspaces",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
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
          // `registered` is literally "no OAuth grant", so anything else IS a grant —
          // a third label here could only ever be wrong about it. A MINTED bearer says
          // so, because the difference is actionable: it expires and it cannot mint.
          principal: registered
            ? "registered_agent"
            : mintedToken
              ? "minted_api_token"
              : "oauth_grant",
          name: agent.name,
          acting_for: actingFor ? (actingFor.name ?? actingFor.id) : null,
          access: scopeForCap,
          // Only tell a connection to mint if it CAN. A registered token already holds a
          // shell-usable bearer, and a minted one is refused (it would renew itself
          // forever) — advice you can't act on is the exact thing this block exists to
          // stop handing out.
          ...(registered || mintedToken
            ? {}
            : {
                note: "Reach REST from your shell at this same access with stage target:'api' (a short-lived bearer). If a workspace ROLE is the limit, an admin changes it; if `access` is the limit, re-consent with a wider scope.",
              }),
        },
        // The live tool surface. A client caches this list at connect and validates
        // arguments against it, so anything shipped since is not just invisible but
        // unusable — and indistinguishable from a feature that was never built. Naming
        // the tools here turns that into a check an agent can actually run: if this
        // list has something yours doesn't, reconnect.
        ...(liveTools
          ? {
              surface: {
                tools: liveTools(),
                note: "The server's tools right now. If your cached list differs, this connection predates a deploy — reconnect to reach what's missing.",
              },
            }
          : {}),
        count: rows.length,
        workspaces: rows,
      })
    },
  )
}

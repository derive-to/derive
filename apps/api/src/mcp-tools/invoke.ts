import { z } from "zod"
import { invokeVerb } from "../lib/verbs"
import type { ToolContext } from "../mcp-tool-context"
import { err, json } from "../mcp-util"

// INVOKE — the third audience. An agent lists an artifact's verbs and clicks one, exactly as a
// human does: the SAME verbs, the SAME gate, the SAME ledger entry. The run acts on behalf of
// the connection's human (audience check), bills to the verb's owner, and lands as a proposal
// or a live publish per the verb's gate. Params are DATA — the owner-authored template is never
// edited by the caller.
export function registerInvokeTool(tc: ToolContext): void {
  const { server, ctx, agent, actingFor, reach, notFound, wsArg } = tc

  server.registerTool(
    "invoke",
    {
      description:
        "List an artifact's action verbs, or invoke one. Verbs are owner-authored buttons on an artifact — the SAME actions a human clicks. Call with just `short_id` to see the verbs (name, params, gate, audience); add `verb` (its name or id) and any `params` to invoke it. The run acts on behalf of your human, bills to the verb's owner, and lands as a proposal or a live publish per the verb's gate. Params are DATA — pass primitives only; they never edit the verb's instruction.",
      inputSchema: {
        short_id: z.string(),
        verb: z
          .string()
          .optional()
          .describe("The verb's name or id. Omit to LIST the artifact's verbs."),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Typed params for the verb (data, not instructions)."),
        workspace: wsArg,
      },
    },
    async ({ short_id, verb, params, workspace }) => {
      const r = await reach(short_id, workspace)
      if (r && "error" in r) return err(r.error)
      if (!r) return notFound(short_id)
      const verbs = await ctx.meta.listVerbsForArtifact(r.a.id)
      if (!verb) {
        return json({
          short_id,
          verbs: verbs.map((v) => ({
            id: v.id,
            name: v.name,
            gate: v.gate,
            audience: v.audience,
            params_schema: v.params_schema ? JSON.parse(v.params_schema) : null,
          })),
          note: verbs.length
            ? "Invoke one by passing `verb` (its name or id) + any `params`."
            : "This artifact has no verbs.",
        })
      }
      const target = verbs.find((v) => v.id === verb || v.name === verb)
      if (!target) return err(`No verb "${verb}" on "${short_id}".`)
      const out = await invokeVerb(
        ctx.meta,
        target,
        actingFor?.id ?? null,
        `agent:${agent.name ?? agent.id}`,
        params,
      )
      if (!out.ok) return err(out.error)
      return json({
        short_id,
        verb: target.name,
        run_id: out.runId,
        status: out.status,
        gate: target.gate,
        note:
          target.gate === "direct"
            ? "Invoked; it will publish directly."
            : "Invoked; it files a proposal for a human to approve.",
      })
    },
  )
}

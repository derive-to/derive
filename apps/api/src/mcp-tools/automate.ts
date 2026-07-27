import { type AutomationTrigger, newId, normalizeSelectors } from "@derive/core"
import { z } from "zod"
import { mintToken, sha256 } from "../lib/crypto"
import { canPayForAgent, NO_PAYER_MESSAGE } from "../lib/payer"
import type { ToolContext } from "../mcp-tool-context"
import { json } from "../mcp-util"

// The AUTOMATE tool: stand up and drive standing instructions over MCP — the setup surface for
// both driving scenarios (keep-an-artifact-fresh, and the context-bound QA runner). One tool,
// three actions, same discipline as `use`: an agent should be able to publish skills, create a
// context, and wire the automations in a single conversation, no UI and no curl.
//
// Mirrors the REST create route's semantics (routes/automations.ts) deliberately: a bound
// context decides the acting agent; no context ⇒ a managed agent auto-mints (its token is NOT
// returned here — hosted dispatch and the polling runner authenticate their own way, and an MCP
// transcript is a bad place for a standing secret); a webhook trigger mints its fire secret,
// returned ONCE like the REST response.

const TRIGGER = z.object({
  kind: z.enum(["manual", "schedule", "event"]),
  cron: z.string().optional(),
  tz: z.string().optional(),
  on: z.string().optional(),
})

export function registerAutomateTool(tc: ToolContext): void {
  const { server, ctx, agent, defaultOrg } = tc
  const meta = ctx.meta
  server.registerTool(
    "automate",
    {
      description:
        "Standing automations — a scheduled use(context, instruction). `create`: trigger ({kind: manual|schedule|event, cron?, tz?, on:'webhook'?}) + instruction; optional refs (targets, mode publish|propose), context_id (run materializes that context's manifest + skills, acts as its agent), connection_ids (bound sources). Webhook triggers return fire_url + fire_secret ONCE. `run_now` enqueues now. `record` files a run you executed LOCALLY (automation_id, wrote:[short_ids], outcome, note) into the same ledger. `list` shows them. Owner grants only.",
      inputSchema: {
        action: z.enum(["create", "list", "run_now", "record"]),
        trigger: TRIGGER.optional(),
        instruction: z.string().min(1).max(4000).optional(),
        refs: z
          .array(
            z.union([
              z.string(),
              z.object({
                kind: z.literal("artifact"),
                id: z.string(),
                mode: z.enum(["publish", "propose"]).optional(),
              }),
              z.object({ kind: z.literal("tag"), tag: z.string() }),
            ]),
          )
          .max(100)
          .optional(),
        context_id: z.string().max(64).optional(),
        connection_ids: z.array(z.string().max(64)).max(20).optional(),
        automation_id: z.string().max(64).optional(),
        // `record` only — what a LOCALLY executed run did, so it lands in the same ledger.
        wrote: z.array(z.string().max(64)).max(20).optional(),
        outcome: z.enum(["published", "proposed", "answered", "shadow", "failed"]).optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => {
      // Same gate as the REST surface: standing jobs are a manage decision, and this tool
      // spends the workspace's model budget on a clock. A commenter grant reads, never wires.
      if (agent.role !== "owner")
        return json({ error: "automations need a manage-level (owner) grant" })
      const org = defaultOrg

      if (input.action === "list") {
        const rows = await meta.listAutomations(org)
        return json({
          count: rows.length,
          automations: rows.map((a) => ({
            id: a.id,
            instruction: a.instruction.slice(0, 140),
            context_id: a.context_id,
            enabled: a.enabled === 1,
          })),
        })
      }

      if (input.action === "run_now") {
        if (!input.automation_id) return json({ error: "run_now needs automation_id" })
        const a = await meta.getAutomation(input.automation_id)
        if (!a || a.org_id !== org) return json({ error: "no such automation" })
        if (a.enabled !== 1) return json({ error: "automation is disabled" })
        // PAYER guard, same as the REST "Run now" (routes/automations.ts). An agent driving
        // this over MCP is the caller least able to see a failure afterwards — it queues and
        // moves on — so refusing here, in the tool result it is already reading, is the only
        // feedback that reliably lands.
        if (
          !(await canPayForAgent(meta, {
            orgId: org,
            agentId: a.agent_id,
            initiator: tc.ownerId ? { userId: tc.ownerId, source: "initiator" } : null,
          }))
        )
          return json({ error: NO_PAYER_MESSAGE })
        const rec = await meta.createRun({
          id: newId("run"),
          org_id: org,
          automation_id: a.id,
          agent_id: a.agent_id,
          reason: "manual:mcp",
          initiated_by: tc.ownerId ?? null,
          scheduled_for: new Date().toISOString(),
        })
        ctx.deps.pokeRun?.(rec.id)
        return json({ run_id: rec.id, status: rec.status })
      }

      if (input.action === "record") {
        // The ledger half of "one QA history, wherever it ran". An agent on someone's laptop
        // (with a browser, local tools, whatever the hosted box lacks) does the work, publishes
        // through the normal gate, then files the receipt here — same run table, same timeline,
        // same automation attribution as a hosted run. `lane: "local"` is stamped so the two are
        // distinguishable in hindsight rather than silently conflated.
        let automationId = input.automation_id ?? null
        if (automationId) {
          const owner = await meta.getAutomation(automationId)
          // Ledger hygiene, mirroring the REST route: an unknown or foreign id is dropped and
          // the run still records, rather than failing work that already happened.
          if (!owner || owner.org_id !== org) automationId = null
        }
        const now = new Date().toISOString()
        const rec = await meta.createRun({
          id: newId("run"),
          org_id: org,
          agent_id: agent.id,
          automation_id: automationId,
          reason: "local",
          initiated_by: tc.ownerId ?? null,
          status: input.outcome === "failed" ? "failed" : "succeeded",
          started_at: now,
          finished_at: now,
          meta: JSON.stringify({
            lane: "local",
            ...(input.outcome ? { outcome: input.outcome } : {}),
            ...(input.note ? { why: input.note } : {}),
            writes: (input.wrote ?? []).map((short_id) => ({ short_id })),
          }),
        })
        return json({
          run_id: rec.id,
          automation_id: automationId,
          recorded: true,
          ...(input.automation_id && !automationId
            ? { note: "automation_id was not in this workspace — recorded unattributed" }
            : {}),
        })
      }

      // create
      if (!input.trigger || !input.instruction)
        return json({ error: "create needs trigger + instruction" })
      let agentId: string | null = null
      if (input.context_id) {
        const bound = await meta.getContext(input.context_id)
        if (!bound || bound.org_id !== org)
          return json({ error: "context must exist in this workspace" })
        agentId = bound.agent_id
      }
      if (!agentId) {
        // Auto-mint a managed agent, exactly like the REST route: nobody picks an agent.
        const base = input.instruction.trim().slice(0, 40).trim() || "Automation"
        const minted = await meta
          .createAgent({
            id: newId("ag"),
            org_id: org,
            name: base,
            token: sha256(mintToken("dk_agt")),
            role: "editor",
            created_by: tc.ownerId ?? null,
            managed: 1,
          })
          .catch(() =>
            meta.createAgent({
              id: newId("ag"),
              org_id: org,
              name: `${base} ${newId("x").slice(-4)}`,
              token: sha256(mintToken("dk_agt")),
              role: "editor",
              created_by: tc.ownerId ?? null,
              managed: 1,
            }),
          )
        agentId = minted.id
      }
      const trigger: AutomationTrigger = { ...input.trigger }
      let fireSecret: string | undefined
      if (trigger.kind === "event" && trigger.on === "webhook") {
        fireSecret = mintToken("dfire")
        trigger.secret_hash = sha256(fireSecret)
      }
      const rec = await meta.createAutomation({
        id: newId("auto"),
        org_id: org,
        agent_id: agentId,
        trigger: JSON.stringify(trigger),
        instruction: input.instruction,
        refs: input.refs ? JSON.stringify(normalizeSelectors(input.refs)) : null,
        connection_ids: input.connection_ids?.length ? JSON.stringify(input.connection_ids) : null,
        context_id: input.context_id ?? null,
        enabled: 1,
      })
      return json({
        id: rec.id,
        context_id: rec.context_id,
        ...(fireSecret
          ? { fire_url: `/v1/automations/${rec.id}/fire`, fire_secret: fireSecret }
          : {}),
      })
    },
  )
}

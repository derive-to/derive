import { type AutomationTrigger, newId, normalizeSelectors, roleAllows } from "@derive/core"
import { z } from "zod"
import { connectionBindError } from "../lib/broker"
import { mintToken, sha256 } from "../lib/crypto"
import { badChoice, choiceDescription } from "../lib/open-choice"
import { canPayForAgent, NO_PAYER_MESSAGE } from "../lib/payer"
import { scopeGapMessage } from "../lib/scope-gap"
import type { ToolContext } from "../mcp-tool-context"
import { json } from "../mcp-util"

// The AUTOMATE tool: stand up and drive standing instructions over MCP — the setup surface for
// both driving scenarios (keep-an-artifact-fresh, and the context-bound QA runner). One tool,
// same discipline as `use`: an agent publishes skills, creates a context (create_context), and
// wires the automations in a single conversation, no UI and no curl.
//
// Mirrors the REST create route's semantics (routes/automations.ts) deliberately: a bound
// context decides the acting agent; no context ⇒ a managed agent auto-mints (its token is NOT
// returned here — hosted dispatch and the polling runner authenticate their own way, and an MCP
// transcript is a bad place for a standing secret); a webhook trigger mints its fire secret,
// returned ONCE like the REST response.

/** The automate actions. A growth point — see lib/open-choice.ts for why it isn't an enum.
 *  Adding one here is the WHOLE change: the schema description and the server-side check
 *  both read this, so they cannot disagree about what is valid. */
const AUTOMATE_ACTIONS = ["create", "list", "run_now", "record", "create_context"] as const

const TRIGGER = z.object({
  kind: z.enum(["manual", "schedule", "event"]),
  cron: z.string().optional(),
  tz: z.string().optional(),
  on: z.string().optional(),
})

export function registerAutomateTool(tc: ToolContext): void {
  const { server, ctx, agent, defaultOrg, scopeForCap, registered } = tc
  const meta = ctx.meta
  server.registerTool(
    "automate",
    {
      description:
        "Standing automations — a scheduled use(context, instruction). `create`: trigger ({kind: manual|schedule|event, cron?, tz?, on:'webhook'?}) + instruction; optional refs (targets, mode publish|propose), context_id (the run acts as that context's agent), connection_ids (bound sources; binding any forces propose, whatever mode says). Webhook triggers return fire_url + fire_secret ONCE. `run_now` enqueues now. `record` files a run you executed LOCALLY (automation_id, wrote:[short_ids], outcome, note) into the same ledger. `list` shows them. `create_context` (name + manifest_short_id, + max_run_ms?/max_concurrency?) wires a context — no token returned; owners run it via use. Owner grants only.",
      inputSchema: {
        // A STRING, not an enum, on purpose: this discriminator grows (create_context is
        // itself the fifth value, and it shipped unreachable to every already-connected
        // client for exactly this reason), and a cached client validates an enum locally —
        // so a newly-shipped action never even reaches the server. See lib/open-choice.ts.
        // Checked server-side below.
        action: z.string().describe(choiceDescription(AUTOMATE_ACTIONS, "What to do.")),
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
        // `create_context` only — wire a new context to a manifest artifact.
        name: z.string().trim().min(1).max(80).optional(),
        manifest_short_id: z.string().max(64).optional(),
        // Coerced for the same reason as publish.wait: added after clients connected, so a
        // stale schema sends these as strings.
        max_run_ms: z.coerce
          .number()
          .int()
          .min(30_000)
          .max(6 * 60 * 60_000)
          .optional(),
        max_concurrency: z.coerce.number().int().min(1).max(10).optional(),
      },
    },
    async (input) => {
      const wrongAction = badChoice("action", input.action, AUTOMATE_ACTIONS)
      if (wrongAction) return json({ error: wrongAction })
      // Same gate as the REST surface: standing jobs are a manage decision, and this tool
      // spends the workspace's model budget on a clock. A commenter grant reads, never wires.
      // The refusal names WHICH lever is short — scope vs seat (see lib/scope-gap.ts) —
      // because they need opposite fixes and guessing wrong sends an agent hunting for a
      // second credential.
      if (agent.role !== "owner") {
        // The RAW membership, not agent.role — that one is already capped BY the scope,
        // so passing it would report a seat gap on every scope gap and send the caller to
        // an admin with nothing to fix. Read only on this refusal path.
        const seat = tc.ownerId
          ? await meta.getMembership(defaultOrg, tc.ownerId).catch(() => null)
          : null
        return json({
          error:
            scopeGapMessage({
              action: "manage",
              scopeRole: scopeForCap,
              memberRole: seat?.role ?? agent.role,
              registered,
              baseUrl: ctx.deps.baseUrl,
            }) ?? "automations need a manage-level (owner) grant",
        })
      }
      const org = defaultOrg

      // THE BETA GATE, the same rule the REST surface applies (routes/automations.ts,
      // `automateOff`): `automateBeta` is the workspace's own opt-in, ships OFF, and binds the
      // lanes that CREATE or RUN work — never reads or deletes. It appeared nowhere in this
      // file, so an agent over MCP could stand up an automation and fire it in a workspace
      // where `POST /v1/automations/:id/run` 404s. The gate held the front door and left this
      // one open.
      //
      // A refusal string rather than a 404: this is a tool result an agent is already reading,
      // and "no such surface" is useless to something that just called it. Fails CLOSED on a
      // settings read error, matching the cron tick and hosted dispatch.
      const automateOff = async (): Promise<boolean> =>
        !(await meta
          .getOrgSettings(org)
          .then((s) => s?.automateBeta === true)
          .catch(() => false))
      if ((input.action === "create" || input.action === "run_now") && (await automateOff()))
        return json({
          error:
            "automations are not enabled for this workspace (automateBeta). An owner can turn " +
            "them on in workspace settings.",
        })

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

      if (input.action === "create_context") {
        // Mirrors the REST create route (routes/contexts.ts) minus the secret: the manifest
        // must be a workspace artifact the caller can SHARE (creating a context exposes its
        // identity to askers), the agent auto-mints managed (REST parity: name collisions
        // suffix, a create failure unwinds the mint), and the dk_agt_ token is NOT returned
        // — an MCP transcript is a bad place for a standing secret. The creating owner runs
        // the context directly (owner-run `use`); a dedicated runner gets a token via REST.
        if (!input.name || !input.manifest_short_id)
          return json({ error: "create_context needs name + manifest_short_id" })
        if (!tc.ownerId) return json({ error: "create_context needs a grant with a known user" })
        const reached = await tc.reach(input.manifest_short_id)
        if (!reached || "error" in reached || reached.a.org_id !== org)
          return json({ error: "no such manifest artifact in this workspace" })
        if (!roleAllows(reached.role, "share"))
          return json({ error: "creating a context needs share standing on the manifest" })
        const mint = (name: string) =>
          meta.createAgent({
            id: newId("ag"),
            org_id: org,
            name,
            token: sha256(mintToken("dk_agt")),
            role: "editor",
            created_by: tc.ownerId,
            managed: 1,
          })
        const minted = await mint(input.name).catch(() =>
          mint(`${input.name} ${newId("x").slice(-4)}`),
        )
        try {
          const created = await meta.createContext({
            id: newId("ctx"),
            org_id: org,
            name: input.name,
            agent_id: minted.id,
            manifest_artifact_id: reached.a.id,
            created_by: tc.ownerId,
            max_run_ms: input.max_run_ms ?? null,
            ...(input.max_concurrency ? { max_concurrency: input.max_concurrency } : {}),
          })
          return json({
            context_id: created.id,
            name: created.name,
            agent_id: minted.id,
            ask_policy: created.ask_policy,
            note:
              "No token is returned over MCP. You (an owner) run this context directly: " +
              "use({context}) pulls its queued work. A dedicated runner's token comes from " +
              "REST agent rotate.",
          })
        } catch {
          // A name-collision after the auto-mint must not strand an orphaned managed agent.
          await meta.deleteAgent(minted.id, org).catch(() => {})
          return json({ error: "a context with that name already exists" })
        }
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
      // Same bind policy as the REST route. This action is owner-grant-only (checked
      // above), which is why canManage is true here; a personal connection still has to
      // belong to the human behind the grant.
      if (input.connection_ids?.length) {
        const bindErr = await connectionBindError(
          meta,
          org,
          { userId: tc.ownerId ?? null, canManage: true },
          input.connection_ids,
        )
        if (bindErr) return json({ error: bindErr })
      }
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

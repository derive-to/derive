import {
  type AutomationTrigger,
  DEFAULT_EXECUTION_PROVIDER,
  EXECUTION_PROVIDERS,
  newId,
  normalizeSelectors,
  roleAllows,
} from "@derive/core"
import { z } from "zod"
import { automationProvider, runMetaForAutomation } from "../lib/automation"
import { connectionBindError } from "../lib/broker"
import { ContextConflictError, createContextCore } from "../lib/create-context"
import { mintToken, sha256 } from "../lib/crypto"
import { parseManifestSkillPins } from "../lib/manifest-pins"
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
        "Scheduled and triggered work: create/list/run_now an automation, record an outcome, or create_context. See derive://skills/loop.",
      // Not read-only (create/run_now/record/create_context all write); no action here
      // deletes or disables an existing automation or context — there is no such action
      // in this tool — so it isn't destructive. Every effect (rows in the automations/
      // runs/contexts tables, a minted managed agent) is Derive's own backend.
      annotations: {
        title: "Manage automations",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        // A STRING, not an enum, on purpose: this discriminator grows (create_context is
        // itself the fifth value, and it shipped unreachable to every already-connected
        // client for exactly this reason), and a cached client validates an enum locally —
        // so a newly-shipped action never even reaches the server. See lib/open-choice.ts.
        // Checked server-side below.
        action: z.string().describe(choiceDescription(AUTOMATE_ACTIONS, "What to do.")),
        // EVERY PARAM BELOW SHIPPED WITH NO DESCRIPTION. Five actions share one schema, so
        // which params an action even reads was unstated — an agent asked to schedule work
        // had to call list() and infer the shape from what came back. Each one leads with the
        // action that reads it, then says the thing that silently goes wrong.
        trigger: TRIGGER.optional()
          .describe(
            'create: {kind:"manual"|"schedule"|"event"}. schedule needs cron+tz. event: only on:"webhook" is dispatched today, and mints a fire secret returned ONCE.',
          )
          // Which sibling fields a `kind` requires is conditional, and a flat object schema
          // cannot express that. One example per kind says it without prose.
          .meta({
            examples: [
              { kind: "schedule", cron: "0 8 * * 1", tz: "America/Los_Angeles" },
              { kind: "event", on: "webhook" },
              { kind: "manual" },
            ],
          }),
        instruction: z
          .string()
          .min(1)
          .max(4000)
          .optional()
          .describe(
            "create: the standing instruction, re-run verbatim. Name the target artifact — a run has no chat history to infer it from.",
          ),
        provider: z
          .enum(EXECUTION_PROVIDERS)
          .optional()
          .describe("create: which coding agent executes it. Default claude-code."),
        refs: z
          .array(
            z.union([
              z.string(),
              z.object({ kind: z.literal("artifact"), id: z.string() }),
              z.object({ kind: z.literal("tag"), tag: z.string() }),
            ]),
          )
          .max(100)
          .optional()
          .describe(
            'create: what the run acts on — short ids, {kind:"artifact",id}, or {kind:"tag",tag}. A run\'s write publishes as a new version of its target (kept, restorable, with the publish fan-out). Duplicates are dropped.',
          ),
        context_id: z
          .string()
          .max(64)
          .optional()
          .describe(
            "create: bind the run to a context, whose agent then acts. Omit and a managed agent is minted for it.",
          ),
        connection_ids: z
          .array(z.string().max(64))
          .max(20)
          .optional()
          .describe(
            "create/create_context: connected sources the run or context may call. An unbound id is refused by id.",
          ),
        automation_id: z
          .string()
          .max(64)
          .optional()
          .describe(
            "run_now: which automation to fire. record: what to attribute to — an id outside this workspace records unattributed.",
          ),
        // `record` only — what a LOCALLY executed run did, so it lands in the same ledger.
        wrote: z
          .array(z.string().max(64))
          .max(20)
          .optional()
          .describe("record: short_ids this run published."),
        outcome: z
          .enum(["published", "answered", "failed"])
          .optional()
          .describe("record: how it ended. Only 'failed' marks the run failed."),
        note: z
          .string()
          .max(500)
          .optional()
          .describe("record: one line on why, kept with the run."),
        // `create_context` only — wire a new context to a manifest artifact.
        name: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .optional()
          .describe("create_context: display name; a collision takes a numeric suffix."),
        manifest_short_id: z
          .string()
          .max(64)
          .optional()
          .describe(
            "create_context: the manifest artifact. Skills load ONLY from its frontmatter `skills:` list — naming one in prose pins nothing.",
          ),
        // Coerced for the same reason as publish.wait: added after clients connected, so a
        // stale schema sends these as strings.
        max_run_ms: z.coerce
          .number()
          .int()
          .min(30_000)
          .max(6 * 60 * 60_000)
          .optional()
          .describe("create_context: per-run wall-clock cap, ms (30000 to 21600000)."),
        max_concurrency: z.coerce
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("create_context: runs allowed in flight at once (1 to 10)."),
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
        // Deliberately NOT gated (reads stay open), but the gate state rides along: a bare
        // `count: 0` in a gated workspace reads as "none yet", and the agent only learns the
        // flag exists when its create is refused. Saying so here is what lets it plan.
        const [rows, off] = await Promise.all([meta.listAutomations(org), automateOff()])
        return json({
          count: rows.length,
          automations_enabled: !off,
          ...(off
            ? {
                note:
                  "automations are not enabled for this workspace (automateBeta) — create and " +
                  "run_now will be refused until an owner turns them on in workspace settings.",
              }
            : {}),
          automations: rows.map((a) => ({
            id: a.id,
            instruction: a.instruction.slice(0, 140),
            context_id: a.context_id,
            provider: automationProvider(a),
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
            provider: automationProvider(a),
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
          meta: runMetaForAutomation(a),
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
        // A context should be testable directly with the same hands its automation will use.
        // Apply the ordinary bind policy before minting anything, so a guessed/foreign id cannot
        // become a context capability and a refusal leaves no orphaned managed agent behind.
        if (input.connection_ids?.length) {
          const bindErr = await connectionBindError(
            meta,
            org,
            { userId: tc.ownerId, canManage: true },
            input.connection_ids,
          )
          if (bindErr) return json({ error: bindErr })
        }
        const reached = await tc.reach(input.manifest_short_id)
        if (!reached || "error" in reached || reached.a.org_id !== org)
          return json({ error: "no such manifest artifact in this workspace" })
        if (!roleAllows(reached.role, "share"))
          return json({ error: "creating a context needs share standing on the manifest" })
        // The pin count the REST create already reports (routes/contexts.ts, skills_count):
        // skills load ONLY from the frontmatter `skills:` list (parseManifestSkillPins), and
        // a prose derive://skills/... mention does nothing — so a manifest whose body names
        // skills but pins none gets told, in the result it is already reading, instead of
        // discovering skills:[] on the finished context. Deliberately no skills param and no
        // prose parsing: pins stay the one way to declare a skill.
        const mv = await meta.getVersion(reached.a.id, reached.a.current_version)
        const manifestMd = mv ? await ctx.sourceText(mv) : null
        const pins = manifestMd ? parseManifestSkillPins(manifestMd) : []
        const bodyMentionsSkills =
          pins.length === 0 &&
          /derive:\/\/skills\//.test(
            (manifestMd ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""),
          )
        try {
          const made = await createContextCore(meta, {
            orgId: org,
            userId: tc.ownerId,
            name: input.name,
            manifestArtifactId: reached.a.id,
            maxRunMs: input.max_run_ms,
            maxConcurrency: input.max_concurrency,
            connectionIds: input.connection_ids,
          })
          return json({
            context_id: made.context.id,
            name: made.context.name,
            agent_id: made.agentId,
            ask_policy: made.context.ask_policy,
            connection_ids: input.connection_ids ?? [],
            skills_count: pins.length,
            ...(bodyMentionsSkills
              ? {
                  skills_hint:
                    "The manifest body mentions derive://skills/... but its frontmatter pins " +
                    "none, so this context loads no skills. Skills must be pinned in " +
                    "frontmatter: skills:\n  - id: <skill short_id>",
                }
              : {}),
            note:
              "No token is returned over MCP. You (an owner) run this context directly: " +
              "use({context}) pulls its queued work. A dedicated runner's token comes from " +
              "REST agent rotate.",
          })
        } catch (err) {
          // Only a context-name collision earns the friendly message, and only
          // ContextConflictError means that: createContextCore tags the case where the mint
          // already succeeded and the context insert did not. Anything else — the mint itself
          // failing, say — is not a naming problem and must not be reported as one.
          if (!(err instanceof ContextConflictError)) throw err
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
        provider: input.provider ?? DEFAULT_EXECUTION_PROVIDER,
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

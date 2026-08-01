import type { MetaStore, OrgSettings, Role } from "@derive/core"
import { overBudget } from "./budget"
import type { ModelCatalog, ResolvedChatModel } from "./model-catalog"

/**
 * EVERY RUNG A CHAT ARRIVAL WALKS, once.
 *
 * Four surfaces now open a chat turn — the workspace page, the document rail, an @derive
 * mention in a comment, an @Derive mention in Slack — and each has to answer the same five
 * questions before spending anybody's model key: has the workspace opted in, does this deploy
 * let it, is the asker a MEMBER (not merely someone holding a link), are they within their rate,
 * and is the workspace within its budget. Plus the two lookups every lane then needs anyway:
 * the seat, and the model.
 *
 * They were written three times. That is worse than verbose: the comment on the first copy
 * claimed collecting them was what stopped the next arrival inheriting four of the five, and
 * then two more arrivals hand-rolled their own. A rung added here now reaches every lane; a rung
 * added to one copy reaches one.
 *
 * WHAT STAYS PER-LANE is only how a refusal is DELIVERED, because that genuinely differs: an
 * HTTP lane returns a status, a comment mention goes quiet (nobody is waiting on a response),
 * and a Slack mention has to say something in the thread or it reads as a broken bot. So this
 * returns a REASON and each lane renders it.
 */
export type ChatRefusal =
  | "not_enabled"
  | "not_allowlisted"
  | "not_member"
  | "rate_limited"
  | "over_budget"
  | "no_model"

export type ChatArrival =
  | { ok: true; settings: OrgSettings; seatRole: Role; model: ResolvedChatModel }
  | { ok: false; reason: ChatRefusal }

export interface ChatGateDeps {
  meta: MetaStore
  models?: ModelCatalog
  /** Workspace ids allowed to spend an operator-paid gateway. Empty/absent = no restriction. */
  chatAllowlist?: string[]
  /** The ask limiter, called with a key the LANE chooses — an HTTP actor, a Slack person. Absent
   *  ⇒ no rate limiting, which is the self-host default. */
  askLimiter?: ((key: string) => Promise<{ ok: boolean; retryAfter?: number }>) | null
}

/**
 * Ordered cheapest-first, and membership BEFORE the two ceilings deliberately: a stranger must
 * not be able to learn a workspace's rate-limit or budget state by probing.
 *
 * Every lookup failure is caught into a refusal rather than thrown. These run on paths with no
 * caller to receive an exception — a detached turn, a webhook that already acked — so a throw
 * here becomes a silent nothing, which is the one outcome worse than a stated refusal.
 */
export const chatArrival = async (
  deps: ChatGateDeps,
  who: { org: string; userId: string; rateKey?: string; modelId?: string | null },
): Promise<ChatArrival> => {
  const settings = await deps.meta.getOrgSettings(who.org).catch(() => null)
  if (!settings?.chatBeta) return { ok: false, reason: "not_enabled" }
  if (deps.chatAllowlist?.length && !deps.chatAllowlist.includes(who.org))
    return { ok: false, reason: "not_allowlisted" }

  // MEMBERSHIP, not merely read access: a viewer LINK satisfies "can see this document" and is
  // not standing to run an agent inside the workspace that owns it.
  const seat = await deps.meta.getMembership(who.org, who.userId).catch(() => null)
  if (!seat) return { ok: false, reason: "not_member" }

  if (who.rateKey && deps.askLimiter) {
    const verdict = await deps.askLimiter(who.rateKey).catch(() => ({ ok: true }))
    if (!verdict.ok) return { ok: false, reason: "rate_limited" }
  }
  // Retrospective by nature — a turn's cost is known when it settles — so this stops the NEXT
  // turn, never the current one. That is exactly why the limiter above is also required, and
  // why neither is redundant with the other.
  if (await overBudget(deps.meta, who.org, who.userId).catch(() => false))
    return { ok: false, reason: "over_budget" }

  const model = deps.models?.resolve(who.modelId ?? null)
  if (!model) return { ok: false, reason: "no_model" }

  return { ok: true, settings, seatRole: seat.role, model }
}

/** What to tell a PERSON who is waiting (a Slack thread, a chat transcript). The HTTP lanes map
 *  the same reasons to status codes instead, so the wording lives in one place per audience. */
export const refusalMessage = (reason: ChatRefusal): string =>
  reason === "not_enabled" || reason === "not_allowlisted"
    ? "Chat is not enabled for this workspace."
    : reason === "not_member"
      ? "You are not a member of this workspace, so I cannot answer here."
      : reason === "rate_limited"
        ? "You are asking faster than I can answer — give me a moment and try again."
        : reason === "over_budget"
          ? "This workspace has reached its monthly model budget, so I cannot answer right now."
          : "No model is configured on this deploy, so I cannot answer."

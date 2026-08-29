import type { MetaStore, ReviewRoundRecord } from "@derive/core"
import { agentName, principalKind } from "./principal-kind"

/** A review round's wire shape: the record, plus the requester's kind read off its id, and —
 *  for a round from before the name was recorded — the directory's name while it still has
 *  one. Shared by the review routes and the workspace activity feed. */
export const roundJson = async (
  meta: Pick<MetaStore, "getAgent" | "getOAuthClientName">,
  r: ReviewRoundRecord,
) => ({
  ...r,
  requested_by_name: r.requested_by_name ?? (await agentName(meta, r.requested_by)),
  requested_by_kind: principalKind(r.requested_by) ?? "user",
})

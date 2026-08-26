import { type ArtifactRecord, type MetaStore, roleAllows } from "@derive/core"

/**
 * Who can answer "let me in" for one artifact.
 *
 * Granting access IS sharing, so the roster is exactly the people who hold `share`
 * on this artifact (editor and up — see permissions.ts NEEDS). Two independent
 * grants produce it, and both have to be consulted: an explicit per-artifact share,
 * and — only when the artifact grants workspace access at all — a workspace seat.
 *
 * A viewer or commenter is deliberately excluded even though they can READ the
 * artifact: a request they cannot act on is a notification that trains people to
 * ignore the bell. For the same reason `author_id` is not a special case; the
 * author appears here through their owner row like anyone else, and an author who
 * has since lost standing genuinely cannot grant.
 *
 * Capped, because the fan-out is an email each and a 200-seat workspace should not
 * receive 200 of them for one stranger. Artifact-level grants sort first: someone
 * explicitly attached to THIS document is likelier to know who the asker is than a
 * workspace admin who has never opened it.
 */
export const MAX_ACCESS_APPROVERS = 10

export const accessApprovers = async (
  meta: Pick<MetaStore, "listArtifactMembers" | "listMemberships">,
  artifact: Pick<ArtifactRecord, "id" | "org_id" | "workspace_access">,
): Promise<string[]> => {
  const shares = await meta.listArtifactMembers(artifact.id)
  const seats =
    artifact.workspace_access === "member" ? await meta.listMemberships(artifact.org_id) : []
  const ordered = [...shares, ...seats].filter((m) => roleAllows(m.role, "share"))
  const seen = new Set<string>()
  for (const m of ordered) seen.add(m.user_id)
  return [...seen].slice(0, MAX_ACCESS_APPROVERS)
}

/** How long one asker's request for one artifact suppresses the next. Long, because
 *  a second email adds nothing an approver did not already have — the first is still
 *  sitting in their inbox — and a stranger refreshing a dead page is the likeliest
 *  way this gets clicked twice. */
export const ACCESS_REQUEST_WINDOW_MS = 6 * 60 * 60 * 1000

/** The asker's own words, bounded. Long enough to say who you are and why you need
 *  it; short enough that it can't be used to mail an essay to a stranger. */
export const ACCESS_REQUEST_NOTE_MAX = 280

/** The bell line. The address is not decoration: the approver grants BY email
 *  through the existing share flow, and a name alone is unresolvable for someone
 *  who has never been in the workspace. */
export const accessRequestPreview = (email: string, note: string | null): string =>
  note ? `${email} — ${note}` : `${email} would like access`

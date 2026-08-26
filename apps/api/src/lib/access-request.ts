import {
  ACCESS_REQUEST_NOTE_MAX,
  type ArtifactRecord,
  type MetaStore,
  maxRole,
  ROLES,
  type Role,
  roleAllows,
} from "@derive/core"

export { ACCESS_REQUEST_NOTE_MAX }

/**
 * Who can answer "let me in" for one artifact.
 *
 * Granting access IS sharing, so the roster is the people who hold `share` on this
 * artifact (editor and up — see permissions.ts NEEDS). THREE independent grants
 * produce that, and all three have to be consulted, because `effectiveRole` takes
 * the max of them: an explicit per-artifact share, a workspace seat when the
 * artifact grants workspace access, and — the one easy to forget — a collection.
 * A collection reaches an artifact through collection_item, and confers its
 * creator's ownership, its own member roles, and (when the collection is open to
 * the workspace) every workspace seat, even on an artifact whose own
 * workspace_access is "none". The shape mirrors `eligibleMentionRecipientIds` in
 * mention-access.ts, which answers the neighbouring question — who may RECEIVE a
 * mention — with the same three grants and no role filter.
 *
 * A viewer or commenter is deliberately excluded even though they can READ the
 * artifact: a request they cannot act on is a notification that trains people to
 * ignore the bell. `author_id` is likewise not a special case; the author appears
 * here through their owner row like anyone else.
 *
 * Capped, because the fan-out is an email each. The cap is what makes the ORDER
 * load-bearing: neither `listMemberships` nor `listArtifactMembers` has an ORDER BY,
 * so slicing the raw concatenation would cut an arbitrary set — and a different
 * arbitrary set on the next call, fanning one person's request out to fresh
 * strangers each time. Sorting by (grant closeness, role rank, user id) makes the
 * cut stable across calls and biased toward the people most attached to the
 * document.
 */
export const MAX_ACCESS_APPROVERS = 5

type ApproverStore = Pick<
  MetaStore,
  | "listArtifactMembers"
  | "listMemberships"
  | "collectionIdsForArtifact"
  | "getCollections"
  | "listCollectionMembers"
>

export const accessApprovers = async (
  meta: ApproverStore,
  artifact: Pick<ArtifactRecord, "id" | "org_id" | "workspace_access">,
): Promise<string[]> => {
  const [shares, memberships, collectionIds] = await Promise.all([
    meta.listArtifactMembers(artifact.id),
    meta.listMemberships(artifact.org_id),
    meta.collectionIdsForArtifact(artifact.id),
  ])

  // Best role per user, and how close the grant that produced it is to the document
  // (0 = on the artifact or a collection holding it, 1 = a workspace seat).
  const best = new Map<string, { role: Role; distance: number }>()
  const add = (userId: string, role: Role, distance: number) => {
    const prior = best.get(userId)
    best.set(userId, {
      role: maxRole(prior?.role, role) ?? role,
      distance: Math.min(prior?.distance ?? distance, distance),
    })
  }

  for (const s of shares) add(s.user_id, s.role, 0)
  if (artifact.workspace_access === "member") for (const m of memberships) add(m.user_id, m.role, 1)
  for (const collection of await meta.getCollections(collectionIds)) {
    // A collection's creator owns it, with or without an explicit member row.
    add(collection.created_by, "owner", 0)
    if (collection.workspace_access === "member")
      for (const m of memberships) add(m.user_id, m.role, 1)
    for (const cm of await meta.listCollectionMembers(collection.id)) add(cm.user_id, cm.role, 0)
  }

  return [...best]
    .filter(([, g]) => roleAllows(g.role, "share"))
    .sort(
      ([aId, a], [bId, b]) =>
        a.distance - b.distance ||
        ROLES.indexOf(b.role) - ROLES.indexOf(a.role) ||
        (aId < bId ? -1 : aId > bId ? 1 : 0),
    )
    .slice(0, MAX_ACCESS_APPROVERS)
    .map(([id]) => id)
}

/** How long one asker's request for one artifact suppresses the next. Long, because
 *  a second email adds nothing an approver did not already have — the first is still
 *  sitting in their inbox — and a stranger refreshing a dead page is the likeliest
 *  way this gets clicked twice. The edge tier cannot express a window this long (its
 *  native limiter caps the period at 60s), so RL_ACCESS_REQUEST approximates it at
 *  1/60s; see worker.ts. */
export const ACCESS_REQUEST_WINDOW_MS = 6 * 60 * 60 * 1000

/** An account display name is free text the asker chose, and it rides an email
 *  subject line to people who never opted in. Bound it there. */
export const ACCESS_REQUEST_NAME_MAX = 60

/**
 * How to name the asker to an approver.
 *
 * An identifier is load-bearing here — the approver grants BY handle or email through
 * the share dialog, and a display name alone is unresolvable — but it is NOT evidence
 * of identity. Sign-in is deliberately never gated on email verification
 * (auth-config.ts) and signup is open, so an unverified address is simply a string the
 * asker typed. Telling an owner to "add dana@partner-co.example" on the strength of it
 * is how a stranger gets granted a colleague's access.
 *
 * Two separate things, kept separate:
 *   - WHAT TO GRANT TO: prefer the @handle. It is unique, bound to this account, and
 *     cannot be claimed twice, so granting to it cannot land on someone else.
 *   - WHETHER THE ADDRESS IS PROVEN: `emailVerified`, and nothing else. A handle is
 *     derived at signup rather than claimed, so holding one says nothing about who
 *     controls the mailbox — folding it into "proven" would suppress a true warning.
 */
export interface Asker {
  name: string | null
  email: string
  username: string | null
  emailVerified: boolean
}

export const askerRef = (asker: Asker): string =>
  asker.username ? `@${asker.username}` : asker.email

export const askerName = (asker: Asker): string =>
  (asker.name ?? asker.email).slice(0, ACCESS_REQUEST_NAME_MAX)

/** The bell line: who to grant to, whether to believe the address, then why. */
export const accessRequestPreview = (asker: Asker, note: string | null): string => {
  const who = asker.emailVerified ? askerRef(asker) : `${askerRef(asker)} (unverified email)`
  return note ? `${who} — ${note}` : `${who} would like access`
}

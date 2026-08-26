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
 * Returns an ORDERED list, bounded but not cut to the final size: the caller resolves
 * the ids to accounts and drops the asker before applying MAX_ACCESS_APPROVERS, so a
 * dangling row or the asker's own entry cannot eat a delivery slot. The order is
 * load-bearing for that cut — neither `listMemberships` nor `listArtifactMembers` has
 * an ORDER BY, so slicing a raw concatenation would take an arbitrary set, and a
 * different arbitrary set next time, fanning one person's request out to fresh
 * strangers on every retry. Sorting by (grant closeness, role rank, user id) makes it
 * stable and biased toward the people most attached to the document.
 */
export const MAX_ACCESS_APPROVERS = 5

/** How many ids this returns for the caller to resolve. Bounds the `getUsers` argument
 *  on a large workspace while leaving enough headroom that unresolvable rows and the
 *  asker's own entry cannot starve the real cap. */
export const PRE_RESOLVE_CAP = 50

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
  const collections = await meta.getCollections(collectionIds)
  // Concurrent, not a loop of awaits: this runs on the exists-and-forbidden branch,
  // whose duration is already the loudest thing about the route, and a serial trip per
  // collection would make that branch's latency scale with a property of the artifact.
  const collectionMembers = await Promise.all(
    collections.map((collection) => meta.listCollectionMembers(collection.id)),
  )
  collections.forEach((collection, i) => {
    // A collection's creator owns it, with or without an explicit member row.
    add(collection.created_by, "owner", 0)
    if (collection.workspace_access === "member")
      for (const m of memberships) add(m.user_id, m.role, 1)
    for (const cm of collectionMembers[i] ?? []) add(cm.user_id, cm.role, 0)
  })

  return [...best]
    .filter(([, g]) => roleAllows(g.role, "share"))
    .sort(
      ([aId, a], [bId, b]) =>
        a.distance - b.distance ||
        ROLES.indexOf(b.role) - ROLES.indexOf(a.role) ||
        (aId < bId ? -1 : aId > bId ? 1 : 0),
    )
    .slice(0, PRE_RESOLVE_CAP)
    .map(([id]) => id)
}

/** How long one asker's request for one artifact suppresses the next. Long, because
 *  a second email adds nothing an approver did not already have — the first is still
 *  sitting in their inbox — and a stranger refreshing a dead page is the likeliest
 *  way this gets clicked twice.
 *
 *  This value applies to the in-process tier only — Node, self-host, dev, tests. The
 *  edge replaces the whole limiter set with native bindings whose period is capped at
 *  60s, so on Workers (which is what production runs) the real suppression is
 *  RL_ACCESS_REQUEST's 1/60s, not this. Six hours is the intent; one minute is what a
 *  hosted deployment enforces. */
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
  // By code point, not code unit: a plain slice can cut an emoji in half and leave a
  // lone surrogate, and this string reaches an email subject line and a stored
  // notification row.
  [...(asker.name ?? asker.email)].slice(0, ACCESS_REQUEST_NAME_MAX).join("")

/** The bell line: who to grant to, whether to believe the address, then why. */
export const accessRequestPreview = (asker: Asker, note: string | null): string => {
  const who = asker.emailVerified ? askerRef(asker) : `${askerRef(asker)} (unverified email)`
  return note ? `${who} — ${note}` : `${who} would like access`
}

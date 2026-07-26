import { useQuery } from "@tanstack/react-query"
import { api, type Follow, type FollowKind } from "@/api"
import { followsQuery } from "./queries"
import { snapshot, useApiMutation } from "./use-api-mutation"

// Path targets are stored verbatim as repo prefixes (e.g. "docs/plans/"); a
// trailing slash keeps a LIKE prefix% from matching a sibling like "docs/plan2".
// Normalize once so the toggle's add/remove and the isFollowingPath check agree.
export const normalizePath = (path: string): string =>
  path && !path.endsWith("/") ? `${path}/` : path

// Author targets are stored lowercased (the backend matches on
// `login.toLowerCase()`), so compare + send the lowercased login.
export const normalizeAuthor = (login: string): string => login.toLowerCase()

// The canonical key for a follow — the same value the isFollowing* sets use. People are
// keyed by @handle (the API returns the handle in `target` for user-follows; an
// optimistic row carries it too), authors lowercased, paths slash-normalized.
export const keyOf = (f: Pick<Follow, "kind" | "target" | "handle">): string =>
  f.kind === "user"
    ? `user:${(f.handle ?? f.target).toLowerCase()}`
    : f.kind === "author"
      ? `author:${f.target.toLowerCase()}`
      : `path:${normalizePath(f.target)}`

/**
 * The caller's follows + the derived follow-state helpers and toggle actions. One query
 * (`followsQuery`) is the source of truth. Every toggle runs through the one governed
 * mutation primitive (`useApiMutation`): OPTIMISTIC — the follows cache is edited on
 * click so every Follow button flips instantly, then rolled back + toasted by the
 * primitive if the write fails; pending is tracked PER target (keyOf) so toggling one
 * button never disables the rest; and on settle both the follows list and any open
 * profile (its stats + followed_by_me) reconcile against the server.
 */
export function useFollows() {
  const fq = followsQuery().queryKey
  const { data: follows = [] } = useQuery(followsQuery())

  const authors = new Set<string>()
  const paths = new Set<string>()
  // People-follows store the @handle in `target` (the API resolves it from the id),
  // so we key follow-state by the (lowercased) username — what every Follow button has.
  const users = new Set<string>()
  for (const fol of follows) {
    if (fol.kind === "author") authors.add(fol.target)
    else if (fol.kind === "path") paths.add(fol.target)
    else if (fol.kind === "user") users.add((fol.handle ?? fol.target).toLowerCase())
  }

  const follow = useApiMutation({
    mutationFn: async ({
      op,
      kind,
      target,
    }: {
      op: "add" | "remove"
      kind: FollowKind
      target: string
    }) => {
      // Discard the differing results (addFollow returns the row, removeFollow void) —
      // the settle invalidation reconciles the cache, so the primitive needs only void.
      if (op === "add") await api.addFollow(kind, target)
      else await api.removeFollow(kind, target)
    },
    // Per-target so one Follow button's flight doesn't disable every other on the page.
    pendingKey: ({ kind, target }) =>
      keyOf({ kind, target, handle: kind === "user" ? target : null }),
    optimistic: ({ op, kind, target }, qc) => {
      const rollback = snapshot(qc, fq)
      const key = keyOf({ kind, target, handle: kind === "user" ? target : null })
      qc.setQueryData<Follow[]>(fq, (cur = []) => {
        if (op === "remove") return cur.filter((f) => keyOf(f) !== key)
        if (cur.some((f) => keyOf(f) === key)) return cur
        const row: Follow = {
          id: `optimistic:${key}`,
          org_id: kind === "user" ? "*" : "",
          user_id: "",
          kind,
          target,
          created_at: new Date().toISOString(),
          ...(kind === "user" ? { handle: target } : {}),
        }
        return [row, ...cur]
      })
      return rollback
    },
    // A settled follow change also shifts any open profile, so reconcile both trees.
    invalidate: [fq, ["profile"]],
  })

  const run = (op: "add" | "remove", kind: FollowKind, target: string) =>
    follow.mutate({ op, kind, target })

  return {
    follows,
    isFollowingAuthor: (login: string) => authors.has(normalizeAuthor(login)),
    isFollowingPath: (path: string) => paths.has(normalizePath(path)),
    // Flip the follow state for an author (by GitHub login).
    toggleAuthor: (login: string) => {
      const target = normalizeAuthor(login)
      run(authors.has(target) ? "remove" : "add", "author", target)
    },
    // Flip the follow state for a repo path prefix (a folder).
    togglePath: (path: string) => {
      const target = normalizePath(path)
      run(paths.has(target) ? "remove" : "add", "path", target)
    },
    // Are we following this person? (by @handle — the universal key for Follow buttons).
    isFollowingUser: (username: string) => users.has(username.toLowerCase()),
    // Flip the follow state for a person by @handle (state read from the live follows set).
    toggleUser: (username: string) => {
      run(users.has(username.toLowerCase()) ? "remove" : "add", "user", username)
    },
    // Is THIS person's follow toggle mid-flight? (per-target, not a global flag).
    isTogglingUser: (username: string) => follow.isPendingFor(`user:${username.toLowerCase()}`),
    // Drop a follow directly (the manage strip's × buttons).
    unfollow: (kind: FollowKind, target: string) => run("remove", kind, target),
  }
}

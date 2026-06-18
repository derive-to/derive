import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo } from "react"
import { toast } from "sonner"
import { api, type FollowKind } from "@/api"
import { followsQuery } from "./queries"

// Path targets are stored verbatim as repo prefixes (e.g. "docs/plans/"); a
// trailing slash keeps a LIKE prefix% from matching a sibling like "docs/plan2".
// Normalize once so the toggle's add/remove and the isFollowingPath check agree.
const normalizePath = (path: string): string => (path && !path.endsWith("/") ? `${path}/` : path)

// Author targets are stored lowercased (the backend matches on
// `login.toLowerCase()`), so compare + send the lowercased login.
const normalizeAuthor = (login: string): string => login.toLowerCase()

/**
 * The caller's follows + the derived follow-state helpers and toggle actions.
 * One query (`followsQuery`) is the single source of truth: `isFollowingAuthor`
 * / `isFollowingPath` drive the Follow buttons, and `toggle*` add/remove then
 * invalidate the query so every toggle + the manage strip reflect the change.
 */
export function useFollows() {
  const qc = useQueryClient()
  const { data: follows = [] } = useQuery(followsQuery())

  const { authors, paths } = useMemo(() => {
    const authors = new Set<string>()
    const paths = new Set<string>()
    for (const fol of follows) {
      if (fol.kind === "author") authors.add(fol.target)
      else paths.add(fol.target)
    }
    return { authors, paths }
  }, [follows])

  const invalidate = () => qc.invalidateQueries({ queryKey: followsQuery().queryKey })

  const add = useMutation({
    mutationFn: ({ kind, target }: { kind: FollowKind; target: string }) =>
      api.addFollow(kind, target),
    onSuccess: invalidate,
    onError: (e) => toast.error((e as Error).message),
  })
  const remove = useMutation({
    mutationFn: ({ kind, target }: { kind: FollowKind; target: string }) =>
      api.removeFollow(kind, target),
    onSuccess: invalidate,
    onError: (e) => toast.error((e as Error).message),
  })

  return {
    follows,
    isFollowingAuthor: (login: string) => authors.has(normalizeAuthor(login)),
    isFollowingPath: (path: string) => paths.has(normalizePath(path)),
    // Flip the follow state for an author (by GitHub login).
    toggleAuthor: (login: string) => {
      const target = normalizeAuthor(login)
      if (authors.has(target)) remove.mutate({ kind: "author", target })
      else add.mutate({ kind: "author", target })
    },
    // Flip the follow state for a repo path prefix (a folder).
    togglePath: (path: string) => {
      const target = normalizePath(path)
      if (paths.has(target)) remove.mutate({ kind: "path", target })
      else add.mutate({ kind: "path", target })
    },
    // Drop a follow directly (the manage strip's × buttons).
    unfollow: (kind: FollowKind, target: string) => remove.mutate({ kind, target }),
  }
}

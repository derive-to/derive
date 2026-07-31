import type { ListEnrichment, ListEnrichmentOpts, MetaStore } from "@derive/core"

/**
 * `listEnrichment` composed from the individual queries, for the embedded drivers
 * (better-sqlite3, D1) where a round trip costs nothing. The Postgres driver
 * overrides this with a single UNION ALL round trip (see pg.ts) — on the edge tier
 * each of these calls is ~80ms of pure wire time, and this method exists so the
 * list pays that once instead of seven times. Both shapes are held to the same
 * assertions by the store contract suite.
 */
export const composeListEnrichment = async (
  store: Pick<
    MetaStore,
    | "viewCounts"
    | "tagsForArtifacts"
    | "previewReady"
    | "usersByGithubIds"
    | "getUsers"
    | "commentSignals"
    | "openProposalCounts"
    | "artifactRolesFor"
  >,
  opts: ListEnrichmentOpts,
): Promise<ListEnrichment> => {
  const views = opts.views ? await store.viewCounts(opts.ids) : {}
  const tags = await store.tagsForArtifacts(opts.ids)
  const previews = await store.previewReady(opts.ids)
  const handles = (await store.usersByGithubIds(opts.ghIds)).map((u) => ({
    gh_id: u.gh_id,
    username: u.username ?? null,
  }))
  const bylines = (await store.getUsers(opts.authorIds)).map((u) => ({
    id: u.id,
    name: u.name ?? null,
    username: u.username ?? null,
  }))
  const signals = opts.viewerId ? await store.commentSignals(opts.ids, opts.viewerId) : {}
  const proposals = await store.openProposalCounts(opts.ids)
  const shareRoles = opts.memberId ? await store.artifactRolesFor(opts.memberId, opts.ids) : {}
  return { views, tags, previews, handles, bylines, signals, proposals, shareRoles }
}

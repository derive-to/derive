import type {
  ArtifactDetail,
  ArtifactDetailOpts,
  AutomationRecord,
  CollectionRecord,
  CommentListOpts,
  CommentRecord,
  ContextRecord,
  ListEnrichment,
  ListEnrichmentOpts,
  MetaStore,
  NotificationsPage,
  OrgSettings,
  RepoSourceRecord,
  Role,
  VersionRecord,
  WorkspaceRecord,
  WorkspaceSummary,
} from "@derive/core"

/**
 * Batched MetaStore methods, composed from their individual queries, for the embedded
 * drivers (better-sqlite3, D1) where a round trip costs nothing. The Postgres driver
 * overrides each of these with a single round trip of its own (see pg.ts) — on the edge
 * tier every round trip is ~80ms of pure wire time, and these methods exist so a route
 * pays that once instead of several times. Both shapes are held to the same assertions
 * by the store contract suite.
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

/** See `composeListEnrichment` — the artifact-detail twin. */
export const composeArtifactDetail = async (
  store: Pick<
    MetaStore,
    | "listVersions"
    | "tagsForArtifacts"
    | "collectionIdsForArtifact"
    | "listProposals"
    | "commentSignals"
    | "listUserFavoriteIds"
    | "getOrgSettings"
    | "managedArtifactIds"
  >,
  opts: ArtifactDetailOpts,
): Promise<ArtifactDetail> => {
  const { artifactId, orgId, viewerId } = opts
  const [versions, tagsById, collectionIds, proposals, signals, favIds, settings, managedIds] =
    await Promise.all([
      store.listVersions(artifactId),
      store.tagsForArtifacts([artifactId]),
      store.collectionIdsForArtifact(artifactId),
      store.listProposals(artifactId),
      store.commentSignals([artifactId], null),
      viewerId ? store.listUserFavoriteIds(viewerId) : Promise.resolve<string[]>([]),
      store.getOrgSettings(orgId),
      store.managedArtifactIds(orgId),
    ])
  return {
    versions,
    tags: tagsById[artifactId] ?? [],
    collectionIds,
    proposals,
    openThreads: signals[artifactId]?.open_threads ?? 0,
    favorite: favIds.includes(artifactId),
    settings,
    managed: managedIds.includes(artifactId),
  }
}

/** See `composeListEnrichment` — the oauth-agent default-workspace resolution's twin. */
export const composeWorkspacesAndOauthBinding = async (
  store: Pick<MetaStore, "listWorkspaces" | "getOAuthClientWorkspaces">,
  userId: string,
  clientId: string,
): Promise<{ mine: (WorkspaceRecord & { role: Role })[]; bound: string[] }> => {
  const [mine, bound] = await Promise.all([
    store.listWorkspaces(userId),
    clientId ? store.getOAuthClientWorkspaces(userId, clientId) : Promise.resolve<string[]>([]),
  ])
  return { mine, bound }
}

/** See `composeListEnrichment` — the Brandprint resolution's twin. */
export const composeOrgContext = async (
  store: Pick<MetaStore, "getOrgSettings" | "getUserBrandprint">,
  orgId: string,
  userId: string | null,
): Promise<{ settings: OrgSettings; personalBrandprint: string | null }> => {
  const [settings, personalBrandprint] = await Promise.all([
    store.getOrgSettings(orgId),
    userId ? store.getUserBrandprint(userId) : Promise.resolve<string | null>(null),
  ])
  return { settings, personalBrandprint }
}

/** See `composeListEnrichment` — the browse sidebar's twin. */
export const composeWorkspaceSummary = async (
  store: Pick<
    MetaStore,
    "countArtifacts" | "tagCounts" | "getWorkspace" | "listUserFavoriteIds" | "countOwnedBy"
  >,
  orgId: string,
  userId: string | null,
): Promise<WorkspaceSummary> => {
  const [total, tags, ws, favIds, mine, minePrivate] = await Promise.all([
    store.countArtifacts(orgId),
    store.tagCounts(orgId),
    store.getWorkspace(orgId),
    userId ? store.listUserFavoriteIds(userId, orgId) : Promise.resolve<string[]>([]),
    userId ? store.countOwnedBy(orgId, userId) : Promise.resolve(0),
    userId ? store.countOwnedBy(orgId, userId, "none") : Promise.resolve(0),
  ])
  return {
    total,
    tags,
    workspace: ws?.name ?? null,
    favorites: favIds.length,
    mine,
    minePrivate,
  }
}

/** See `composeListEnrichment` — the comment rail's twin (comments + anchor version). */
export const composeCommentsPage = async (
  store: Pick<MetaStore, "listComments" | "getVersion">,
  artifactId: string,
  versionN: number,
  opts?: CommentListOpts,
): Promise<{ comments: CommentRecord[]; version: VersionRecord | null }> => {
  const [comments, version] = await Promise.all([
    store.listComments(artifactId, opts),
    store.getVersion(artifactId, versionN),
  ])
  return { comments, version }
}

/** See `composeListEnrichment` — the contexts list's manifest resolution. */
export const composeContextsWithManifests = async (
  store: Pick<MetaStore, "listContexts" | "getArtifactsByIds">,
  orgId: string,
): Promise<(ContextRecord & { manifest_short_id: string | null })[]> => {
  const rows = await store.listContexts(orgId)
  const manifests = await store.getArtifactsByIds(rows.map((x) => x.manifest_artifact_id))
  const shortById = new Map(manifests.map((a) => [a.id, a.short_id]))
  return rows.map((x) => ({
    ...x,
    manifest_short_id: shortById.get(x.manifest_artifact_id) ?? null,
  }))
}

/** See `composeListEnrichment` — the notifications-bell twin (page + true total unread). */
export const composeNotificationsPage = async (
  store: Pick<MetaStore, "listNotifications" | "unreadNotificationCount">,
  userId: string,
  limit: number,
): Promise<NotificationsPage> => {
  const [notifications, unread] = await Promise.all([
    store.listNotifications(userId, limit),
    store.unreadNotificationCount(userId),
  ])
  return { notifications, unread }
}

/** See `composeListEnrichment` — the automations list's executor-liveness join. */
export const composeAutomationsWithExecutors = async (
  store: Pick<MetaStore, "listAutomations" | "listAgents">,
  orgId: string,
  limit?: number,
): Promise<(AutomationRecord & { executor_seen_at: string | null })[]> => {
  const [autos, agents] = await Promise.all([
    store.listAutomations(orgId, limit),
    store.listAgents(orgId),
  ])
  const seen = new Map(agents.map((a) => [a.id, a.runs_seen_at]))
  return autos.map((a) => ({ ...a, executor_seen_at: seen.get(a.agent_id) ?? null }))
}

/** See `composeListEnrichment` — the collections list's org-scoped pair. */
export const composeCollectionsOverview = async (
  store: Pick<MetaStore, "listCollections" | "listRepoSources">,
  orgId: string,
): Promise<{
  collections: (CollectionRecord & { count: number })[]
  sources: RepoSourceRecord[]
}> => {
  const [collections, sources] = await Promise.all([
    store.listCollections(orgId),
    store.listRepoSources(orgId),
  ])
  return { collections, sources }
}

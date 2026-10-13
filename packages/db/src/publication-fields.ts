import type { NewArtifact, NewVersion } from "@derive/core"

/** Storage projection shared by each native atomic publication. */
export const artifactVersionFields = (v: NewVersion, n: number, at: string) => ({
  current_version: n,
  current_content_type: v.content_type,
  updated_at: at,
  author_name: v.author,
  author_login: v.author_login ?? null,
  author_avatar: v.author_avatar ?? null,
  author_gh_id: v.author_gh_id ?? null,
  author_id: v.author_id ?? null,
})

export const publishedArtifactFields = (a: NewArtifact, v: NewVersion, at: string) => ({
  ...a,
  created_at: at,
  ...artifactVersionFields(v, 1, at),
})

/** Coalescing retains the row's id and number and invalidates derived render data. */
export const replacementVersionFields = (v: NewVersion, at: string) => ({
  blob_key: v.blob_key,
  content_type: v.content_type,
  size_bytes: v.size_bytes ?? 0,
  author: v.author,
  author_login: v.author_login ?? null,
  author_avatar: v.author_avatar ?? null,
  author_gh_id: v.author_gh_id ?? null,
  author_id: v.author_id ?? null,
  agent_id: v.agent_id ?? null,
  agent_name: v.agent_name ?? null,
  source: v.source ?? null,
  message: v.message,
  name: v.name ?? null,
  edit_session: v.edit_session ?? null,
  created_at: at,
  preview_key: null,
  preview_status: null,
  preview_error: null,
  preview_full_key: null,
  preview_full_status: null,
  preview_full_error: null,
  preview_marked_key: null,
  preview_marked_status: null,
  preview_marked_error: null,
  summary: null,
  summary_src_hash: null,
})

import type { Quote } from "@aniraga/open-artifact-protocol"
import {
  parseElementSelector,
  parseSourceQuoteSelector,
} from "@aniraga/open-artifact-protocol/source"
import { type ArtifactStore, type CommentRow, HttpError } from "@aniraga/open-artifact-server/kit"
import type { CommentRecord, CommentState, MetaStore, NewComment } from "./ports"

export const commentQuoteOf = (anchor: string | null): Quote | null => {
  if (!anchor) return null
  const text = parseSourceQuoteSelector(anchor)
  const label = text?.exact ?? parseElementSelector(anchor)?.snapshot.label
  return {
    exact: typeof label === "string" && label ? label.slice(0, 2_000) : "Element",
    prefix: text?.prefix?.slice(-64) ?? "",
    suffix: text?.suffix?.slice(0, 64) ?? "",
    sourceSelector: anchor,
  }
}

const visibleBody = (row: CommentRecord): string => {
  try {
    const meta = row.meta ? (JSON.parse(row.meta) as { deleted?: unknown } | null) : null
    if (meta?.deleted) return ""
  } catch {
    // Malformed legacy metadata has the same meaning as absent metadata.
  }
  return row.body_md
}

const commentRowOf = (row: CommentRecord): CommentRow => ({
  id: row.id,
  artifactId: row.artifact_id,
  threadId: row.thread_id,
  version: row.base_version,
  quote: commentQuoteOf(row.anchor),
  body: visibleBody(row),
  author: { id: row.author_id ?? `legacy:${row.author}`, name: row.author },
  createdAt: row.created_at,
})

type Comments = Pick<
  ArtifactStore,
  "createThread" | "addComment" | "setThreadState" | "listThreads"
>

export interface NativeCommentWrite {
  comment: NewComment
  capture?: (saved: CommentRecord) => void
}

/** Prepared native input retains paths, mentions, and nullable legacy attribution. */
export const artifactStoreComments = (meta: MetaStore, write?: NativeCommentWrite): Comments => {
  const input = write?.comment
  const save = async (row: CommentRow, state: CommentState) => {
    const saved = await meta.createComment({
      ...input,
      id: row.id,
      artifact_id: row.artifactId,
      thread_id: row.threadId,
      state,
      base_version: input?.base_version ?? row.version,
      body_md: row.body,
      author: input?.author ?? row.author.name,
      author_id: input ? input.author_id : row.author.id,
      anchor:
        input?.anchor !== undefined
          ? input.anchor
          : (row.quote?.sourceSelector ??
            (row.quote ? JSON.stringify({ type: "TextQuoteSelector", ...row.quote }) : null)),
    })
    write?.capture?.(saved)
  }
  return {
    createThread: async (thread, first) => {
      if (first.threadId !== thread.id || first.artifactId !== thread.artifactId)
        throw new HttpError(400, "The comment does not belong to its supplied thread.")
      await save(first, thread.state)
    },
    addComment: async (row) => {
      const root = (await meta.listComments(row.artifactId, { threadId: row.threadId }))[0]
      if (!root || root.artifact_id !== row.artifactId) throw new HttpError(404, "No such thread.")
      await save(row, root.state)
    },
    setThreadState: async (id, threadId, state) =>
      (await meta.setThreadState(id, threadId, state)) > 0,
    listThreads: async (id) => {
      const rows = await meta.listComments(
        id,
        input?.artifact_id === id ? { threadId: input.thread_id } : undefined,
      )
      const threads = new Map<string, { id: string; artifactId: string; state: CommentState }>()
      for (const row of rows)
        if (!threads.has(row.thread_id) || row.id === row.thread_id)
          threads.set(row.thread_id, { id: row.thread_id, artifactId: id, state: row.state })
      return { threads: [...threads.values()], comments: rows.map(commentRowOf) }
    },
  }
}

import {
  HttpError as ArtifactError,
  createEvents,
  createThreadService,
} from "@aniraga/open-artifact-server/source"
import { createArtifactStore } from "./artifact-store"
import { commentQuoteOf } from "./artifact-store-comments"
import { artifactRowOf } from "./artifact-store-records"
import type { ArtifactRecord, CommentRecord, CommentState, MetaStore, NewComment } from "./ports"

/** Host validation and workflows surround the shared comment write module. */
export const postArtifactComment = async (
  meta: MetaStore,
  artifact: ArtifactRecord,
  input: NewComment,
): Promise<CommentRecord> => {
  let created: CommentRecord | undefined
  const store = createArtifactStore(meta, {
    comment: {
      comment: input,
      capture: (row) => {
        created = row
      },
    },
  })
  const threads = createThreadService({ store }, createEvents(), () => ({
    threadId: input.thread_id,
    commentId: input.id,
  }))
  const actor = { id: input.author_id ?? "anonymous", name: input.author }
  const row = artifactRowOf(artifact)
  const existing =
    input.id === input.thread_id
      ? []
      : await meta.listComments(artifact.id, { threadId: input.thread_id })
  if (!existing.length) {
    const foreign = input.id === input.thread_id ? null : await meta.getComment(input.thread_id)
    if (foreign && foreign.artifact_id !== artifact.id)
      throw new ArtifactError(404, "No such thread.")
    await threads.start(actor, row, {
      body: input.body_md,
      quote: commentQuoteOf(input.anchor ?? null),
      version: input.base_version,
    })
  } else await threads.reply(actor, row, input.thread_id, input.body_md)
  if (!created) throw new Error("The comment write did not return its native record")
  return created
}

/** Retain the native update count while the kit owns thread transitions and missing refusal. */
export const setArtifactThreadState = async (
  meta: MetaStore,
  artifact: ArtifactRecord,
  input: {
    threadId: string
    state: Extract<CommentState, "open" | "resolved">
    actor: { id: string | null; name: string | null } | null
  },
): Promise<number> => {
  let updated = 0
  const store = createArtifactStore(meta, {
    threadState: {
      artifactId: artifact.id,
      threadId: input.threadId,
      capture: (count) => {
        updated = count
      },
    },
  })
  const threads = createThreadService({ store }, createEvents())
  await threads.setState(
    { id: input.actor?.id ?? "anonymous", name: input.actor?.name ?? "Anonymous" },
    artifactRowOf(artifact),
    input.threadId,
    input.state,
  )
  return updated
}

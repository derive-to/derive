import type { Actor } from "@aniraga/open-artifact-protocol"
import type { ArtifactStore } from "@aniraga/open-artifact-server/kit"
import { artifactStoreComments, type NativeCommentWrite } from "./artifact-store-comments"
import { artifactStoreReads } from "./artifact-store-reads"
import { artifactStoreState } from "./artifact-store-state"
import { artifactStoreWrites, type NativePublication } from "./artifact-store-writes"
import type { MetaStore } from "./ports"

/** One adapter owns native row conversion and atomic storage for the complete kit. */
export const createArtifactStore = (
  meta: MetaStore,
  input: { publication?: NativePublication; comment?: NativeCommentWrite; actor?: Actor } = {},
): ArtifactStore => ({
  ...artifactStoreReads(meta),
  ...artifactStoreWrites(meta, input.publication),
  ...artifactStoreComments(meta, input.comment),
  ...artifactStoreState(meta, input.actor),
})

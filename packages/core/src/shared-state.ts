export {
  commitArtifactState,
  StoredStateError,
} from "@aniraga/open-artifact-server/collections"

import {
  createCollectionRules,
  isStateKey,
  STATE_KEY_PATTERN,
  STATE_LIMITS,
} from "@aniraga/open-artifact-protocol/collection"

/** Keep existing persisted ownership fields, mutation markers, and supplied-id rules. */
export const artifactCollection = createCollectionRules({
  actorField: "__derive_actor_id",
  slotField: "__derive_slot",
  incrementKey: "__derive_increment",
  strictIds: true,
})

/** The one intentionally small contract shared by the artifact runtime, host,
 * API, and stores. Shared state is a collection primitive, not a generic app
 * backend: one key owns one bounded array of JSON objects. */
export const SHARED_STATE_KEY_PATTERN = STATE_KEY_PATTERN
export const SHARED_STATE_MAX_KEYS = STATE_LIMITS.keys
export const SHARED_STATE_MAX_ITEMS = STATE_LIMITS.items
export const SHARED_STATE_MAX_BYTES = STATE_LIMITS.bytes
export const SHARED_STATE_ACTIVITY_LIMIT = STATE_LIMITS.activity

export const isSharedStateKey = isStateKey

export type SharedStateAction = "add" | "update" | "set_mine"

export type SharedStateMutation =
  | { op: "add"; initial: unknown; value: Record<string, unknown> }
  | { op: "update"; initial: unknown; id: string; patch: Record<string, unknown> }
  | {
      op: "set_mine"
      initial: unknown
      slot: string
      value: Record<string, unknown> | null
    }

export interface SharedStateResult {
  value: unknown
  version: number
  /** Item ids owned by the caller, keyed by the artifact-defined slot. The
   * server never exposes another actor's ownership metadata. */
  mine: Record<string, string>
  /** Present after a mutation; identifies the item changed by this request. */
  itemId?: string
}

export interface SharedStateActivity {
  action: SharedStateAction
  version: number
  item_id: string
  actor: { id: string; name: string }
  at: string
}

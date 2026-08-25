/** The one intentionally small contract shared by the artifact runtime, host,
 * API, and stores. Shared state is a collection primitive, not a generic app
 * backend: one key owns one bounded array of JSON objects. */
export const SHARED_STATE_KEY_PATTERN = "^[A-Za-z][A-Za-z0-9_-]{0,63}$"
export const SHARED_STATE_MAX_KEYS = 16
export const SHARED_STATE_MAX_ITEMS = 2_000
export const SHARED_STATE_MAX_BYTES = 256 * 1024
export const SHARED_STATE_ACTIVITY_LIMIT = 50

const SHARED_STATE_KEY = new RegExp(SHARED_STATE_KEY_PATTERN)

export const isSharedStateKey = (key: string): boolean => SHARED_STATE_KEY.test(key)

export type SharedStateAction = "add" | "update"

export type SharedStateMutation =
  | { op: "add"; initial: unknown; value: Record<string, unknown> }
  | { op: "update"; initial: unknown; id: string; patch: Record<string, unknown> }

export interface SharedStateResult {
  value: unknown
  version: number
}

export interface SharedStateActivity {
  action: SharedStateAction
  version: number
  item_id: string
  actor: { id: string; name: string }
  at: string
}

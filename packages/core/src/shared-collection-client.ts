import type { Activity, Snapshot, StateItem } from "@aniraga/open-artifact-protocol"
import { isStateKey } from "@aniraga/open-artifact-protocol/collection"
import { createShared, type StateBackend } from "@aniraga/open-artifact-runtime/shared"

type Message = Record<string, unknown>
type Pending = { resolve(value: unknown): void; reject(error: Error): void }
type SharedHandle = {
  readonly value: StateItem[]
  readonly ready: Promise<StateItem[]>
  onChange(listener: (items: StateItem[]) => void): () => void
  add(value: Record<string, unknown>): Promise<StateItem[]>
  update(id: string, patch: Record<string, unknown>): Promise<StateItem[]>
  setMine(slot: string, value: Record<string, unknown> | null): Promise<StateItem[]>
  mine(slot: string): StateItem | null
  activity(): Promise<unknown[]>
}
type AuthorRoot = {
  shared?: (key: string, initial?: unknown[]) => SharedHandle
  increment?: (by: number) => Record<string, number>
}

const recordOf = (value: unknown): Message | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Message) : null

const snapshotOf = (value: unknown, previousMine: Record<string, string>): Snapshot => {
  const data = recordOf(value)
  const items = data?.value
  const mine = data?.mine === undefined ? previousMine : recordOf(data.mine)
  if (
    !data ||
    !Number.isSafeInteger(data.version) ||
    Number(data.version) < 0 ||
    (items !== null &&
      (!Array.isArray(items) || items.some((item) => typeof recordOf(item)?.id !== "string"))) ||
    !mine ||
    Object.values(mine).some((id) => typeof id !== "string") ||
    (data.itemId !== undefined && typeof data.itemId !== "string")
  )
    throw new Error("Invalid shared-state response")
  return {
    items: items as StateItem[] | null,
    version: Number(data.version),
    mine: mine as Record<string, string>,
    ...(typeof data.itemId === "string" ? { itemId: data.itemId } : {}),
  }
}

const activityOf = (value: unknown): Activity[] => {
  const rows = recordOf(value)?.activity
  if (!Array.isArray(rows)) throw new Error("Invalid shared-state activity response")
  return rows.map((row) => {
    const data = recordOf(row)
    const actor = recordOf(data?.actor)
    const action = data?.action === "set_mine" ? "setMine" : data?.action
    if (
      !data ||
      !["add", "update", "setMine"].includes(String(action)) ||
      typeof data.item_id !== "string" ||
      typeof data.version !== "number" ||
      typeof data.at !== "string" ||
      typeof actor?.id !== "string" ||
      typeof actor.name !== "string"
    )
      throw new Error("Invalid shared-state activity response")
    return {
      action: action as Activity["action"],
      itemId: data.item_id,
      version: data.version,
      at: data.at,
      actor: { id: actor.id, name: actor.name },
    }
  })
}

export const installCollections = (hostReady: () => void) => {
  const global = window as Window & { derive?: AuthorRoot }
  const prior = global.derive
  const root = prior && (typeof prior === "object" || typeof prior === "function") ? prior : {}
  if (typeof root.shared === "function") return
  const handles = new Map<string, SharedHandle>()
  const pending = new Map<string, Pending>()
  const listeners = new Map<string, Set<(snapshot: Snapshot) => void>>()
  const latest = new Map<string, Snapshot>()
  const queued: Message[] = []
  let connected = false
  let sequence = 0

  const request = (type: string, key: string, fields: Message = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const requestId = `shared_${Date.now().toString(36)}_${++sequence}`
      pending.set(requestId, { resolve, reject })
      const message = { source: "derive", type, requestId, key, ...fields }
      if (connected) parent.postMessage(message, "*")
      else queued.push(message)
    })
  const deliver = (key: string, snapshot: Snapshot) => {
    for (const listener of listeners.get(key) ?? []) listener(snapshot)
  }
  const receiveSnapshot = (key: string, data: unknown) => {
    const previous = latest.get(key)
    const snapshot = snapshotOf(data, previous?.mine ?? {})
    if (!previous || snapshot.version >= previous.version) latest.set(key, snapshot)
    return snapshot
  }
  const backend: StateBackend = {
    read: async (key) => receiveSnapshot(key, await request("shared-open", key)),
    mutate: async (key, mutation, initial) =>
      receiveSnapshot(
        key,
        await request("shared-mutate", key, {
          mutation: {
            ...mutation,
            op: mutation.op === "setMine" ? "set_mine" : mutation.op,
            initial,
          },
        }),
      ),
    activity: async (key) => activityOf(await request("shared-activity", key)),
    watch: (key, listener) => {
      const set = listeners.get(key) ?? new Set()
      set.add(listener)
      listeners.set(key, set)
    },
  }

  window.addEventListener("message", (event) => {
    if (event.source !== parent) return
    const data = recordOf(event.data)
    if (data?.source !== "derive-host") return
    if (data.type === "shared-ready") {
      connected = true
      hostReady()
      for (const message of queued.splice(0)) parent.postMessage(message, "*")
    } else if (data.type === "shared-resync") {
      for (const key of listeners.keys())
        void backend.read(key).then(
          (snapshot) => deliver(key, snapshot),
          () => undefined,
        )
    } else if (data.type === "shared-updated" && typeof data.key === "string") {
      try {
        deliver(data.key, receiveSnapshot(data.key, data))
      } catch {
        // A malformed host update cannot overwrite the last accepted state.
      }
    } else if (data.type === "shared-result" && typeof data.requestId === "string") {
      const call = pending.get(data.requestId)
      if (!call) return
      pending.delete(data.requestId)
      if (!data.ok)
        call.reject(
          new Error(typeof data.error === "string" ? data.error : "shared-state request failed"),
        )
      else {
        if (!Array.isArray(data.activity) && typeof data.key === "string") {
          try {
            deliver(data.key, receiveSnapshot(data.key, data))
          } catch (error) {
            call.reject(error instanceof Error ? error : new Error("Invalid shared-state response"))
            return
          }
        }
        call.resolve(data)
      }
    }
  })

  root.shared = (key, initial = []) => {
    if (!isStateKey(key)) throw new Error("invalid shared-state key")
    const existing = handles.get(key)
    if (existing) return existing
    const shared = createShared(backend, key, initial, {
      actorField: "__derive_actor_id",
      slotField: "__derive_slot",
      incrementKey: "__derive_increment",
      strictIds: true,
    })
    const valueAfter = async (write: Promise<unknown>) => {
      await write
      return shared.value
    }
    const handle: SharedHandle = {
      get value() {
        return shared.value
      },
      ready: shared.ready.then(() => shared.value),
      onChange: shared.onChange,
      add: (value) => valueAfter(shared.add(value)),
      update: (id, patch) => valueAfter(shared.update(id, patch)),
      setMine: (slot, value) => {
        if (typeof slot !== "string" || !slot.length || slot.length > 128)
          throw new Error("mine slot must be a 1-128 character string")
        if (value !== null && !recordOf(value))
          throw new Error("setMine value must be an object or null")
        return valueAfter(shared.setMine(slot, value))
      },
      mine: (slot) => shared.mine(slot) ?? null,
      activity: async () =>
        (await shared.activity()).map(({ itemId, action, ...row }) => ({
          ...row,
          item_id: itemId,
          action: action === "setMine" ? "set_mine" : action,
        })),
    }
    handle.ready.catch(() => undefined)
    handles.set(key, handle)
    return handle
  }
  root.increment = (by) => {
    if (!Number.isFinite(by)) throw new Error("increment requires a number")
    return { __derive_increment: by }
  }
  global.derive = root
  window.dispatchEvent(new CustomEvent("derive-ready", { detail: root }))
}

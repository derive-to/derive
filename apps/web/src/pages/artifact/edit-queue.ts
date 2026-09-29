import type { SourceOp } from "@derive/core"
import { STORAGE_KEYS } from "@/lib/storage-keys"

/**
 * Inline edits the server hasn't confirmed, kept on this device until it does.
 *
 * Every save is written here before it is sent and cleared once it lands, so a save
 * that can't reach the server (offline, or the tab closed mid-flight) is still here on
 * the next visit, ready to send again. One entry per artifact: a save always carries
 * everything that differs from what the server holds, so the latest supersedes the rest.
 * localStorage, because the entry must be readable synchronously as the page leaves
 * (the unload warning asks whether anything is waiting).
 */
export interface QueuedSave {
  /** Ops with their hashes filled, as sent. */
  ops: SourceOp[]
  base: number
  message: string
  session: string
  /** How many changes it carries, for "Offline — 3 edits waiting". */
  count: number
}

const readAll = (): Record<string, QueuedSave> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.editQueue)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}
const writeAll = (all: Record<string, QueuedSave>) => {
  try {
    if (Object.keys(all).length) localStorage.setItem(STORAGE_KEYS.editQueue, JSON.stringify(all))
    else localStorage.removeItem(STORAGE_KEYS.editQueue)
  } catch {
    /* storage full or blocked: the in-memory queue still retries while the page is open */
  }
}

export const queuedSave = (shortId: string): QueuedSave | null => {
  const q = readAll()[shortId]
  return q && Array.isArray(q.ops) && typeof q.base === "number" ? q : null
}
export const queueSave = (shortId: string, save: QueuedSave) =>
  writeAll({ ...readAll(), [shortId]: save })
export const clearQueuedSave = (shortId: string) => {
  const all = readAll()
  if (!(shortId in all)) return
  delete all[shortId]
  writeAll(all)
}

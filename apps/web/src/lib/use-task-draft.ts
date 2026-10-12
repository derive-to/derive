import { useState } from "react"
import { STORAGE_KEYS } from "./storage-keys"

/** A saved draft includes its submission key, so reconnect and reload preserve safe replay. */
export function useTaskDraft(scope: string, userId: string | undefined) {
  const storageKey = `${STORAGE_KEYS.taskDraft}${userId ?? ""}.${scope}`
  const [draft, setDraft] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null")
      if (
        saved &&
        typeof saved.text === "string" &&
        saved.text.length <= 20_000 &&
        typeof saved.key === "string" &&
        /^[a-f0-9-]{36}$/.test(saved.key)
      )
        return {
          text: saved.text,
          key: saved.key,
          agentId: typeof saved.agentId === "string" ? saved.agentId : "",
        }
    } catch {
      /* A unavailable or old draft does not block work. */
    }
    return { text: "", key: crypto.randomUUID(), agentId: "" }
  })
  const save = (next: typeof draft) => {
    setDraft(next)
    try {
      if (next.text) sessionStorage.setItem(storageKey, JSON.stringify(next))
      else sessionStorage.removeItem(storageKey)
    } catch {
      /* The current tab still retains its draft. */
    }
  }
  return {
    ...draft,
    change: (text: string) => save({ ...draft, text, key: crypto.randomUUID() }),
    choose: (agentId: string) => save({ ...draft, agentId, key: crypto.randomUUID() }),
    retry: () => save({ ...draft, key: crypto.randomUUID() }),
    clear: () => save({ text: "", key: crypto.randomUUID(), agentId: draft.agentId }),
  }
}

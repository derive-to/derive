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
          action:
            saved.action === "answer" || saved.action === "follow_up"
              ? (saved.action as "answer" | "follow_up")
              : null,
          questionId: typeof saved.questionId === "string" ? saved.questionId : null,
        }
    } catch {
      /* A unavailable or old draft does not block work. */
    }
    return {
      text: "",
      key: crypto.randomUUID(),
      agentId: "",
      action: null as "answer" | "follow_up" | null,
      questionId: null as string | null,
    }
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
    change: (text: string) =>
      save({ ...draft, text, key: crypto.randomUUID(), action: null, questionId: null }),
    choose: (agentId: string) =>
      save({ ...draft, agentId, key: crypto.randomUUID(), action: null, questionId: null }),
    submission: (action: "answer" | "follow_up", questionId: string | null) => {
      if (draft.action) return draft
      const next = { ...draft, action, questionId }
      save(next)
      return next
    },
    retry: (status?: number) => {
      if (status === undefined || status === 401 || status >= 500) return
      save({ ...draft, key: crypto.randomUUID(), action: null, questionId: null })
    },
    clear: () =>
      save({
        text: "",
        key: crypto.randomUUID(),
        agentId: draft.agentId,
        action: null,
        questionId: null,
      }),
  }
}

const KEY = "derive:guest-name"
const MAX = 80

/** The guest's self-provided display name, persisted per browser so external
 *  reviewers name themselves once. Display-only — never an identity. */
export const getGuestName = (): string => {
  try {
    return (localStorage.getItem(KEY) ?? "").trim().slice(0, MAX)
  } catch {
    return ""
  }
}

export const setGuestName = (name: string): void => {
  try {
    localStorage.setItem(KEY, name.trim().slice(0, MAX))
  } catch {
    // Storage unavailable (private mode): the field still works per-pageload.
  }
}

import { autocompletion, type CompletionContext } from "@codemirror/autocomplete"
import type { Extension } from "@codemirror/state"
import { api } from "@/api"

/** Source documents store durable @handles; this picker is deliberately lazy so
 * it enriches authorship without making the CodeMirror baseline heavier. */
export const sourceMentionCompletion = (shortId?: string): Extension =>
  autocompletion({ override: [sourceMentionCompletions(shortId)] })

const sourceMentionCompletions = (shortId?: string) => async (context: CompletionContext) => {
  const before = context.matchBefore(/@[a-zA-Z0-9_-]*/)
  if (!before || (before.from === before.to && !context.explicit)) return null
  // Do not offer a person picker in an email address, URL, or a longer identifier.
  if (before.from > 0 && /[a-z0-9._@-]/i.test(context.state.sliceDoc(before.from - 1, before.from)))
    return null
  try {
    const { users } = await api.users(before.text.slice(1), shortId)
    const options = users
      // Source mentions wake people; agents remain thread-only until body mentions
      // have a canonical reply surface.
      .filter((user) => user.kind !== "agent" && !!user.handle)
      .slice(0, 6)
      .map((user) => ({
        label: `@${user.handle}`,
        detail: user.name ?? undefined,
        type: "user",
        apply: `@${user.handle} `,
      }))
    return options.length ? { from: before.from, options } : null
  } catch {
    // Directory search is an affordance; raw @handles still publish safely if unavailable.
    return null
  }
}

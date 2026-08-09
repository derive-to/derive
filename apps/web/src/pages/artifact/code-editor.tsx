import { autocompletion, type CompletionContext } from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { html } from "@codemirror/lang-html"
import { markdown } from "@codemirror/lang-markdown"
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language"
import { EditorState } from "@codemirror/state"
import {
  placeholder as cmPlaceholder,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view"
import { tags as t } from "@lezer/highlight"
import { useEffect, useRef } from "react"
import { api } from "@/api"

/** A source document stores durable, portable @handles rather than app-private mention ids. The
 * server resolves those handles when the version publishes; this picker makes the write path as
 * discoverable as comment mentions without pretending source text has a comment-thread reply. */
const sourceMentionCompletions = (shortId?: string) => async (context: CompletionContext) => {
  const before = context.matchBefore(/@[a-zA-Z0-9_-]*/)
  if (!before || (before.from === before.to && !context.explicit)) return null
  // Do not offer a person picker in an email address, URL, or a longer identifier.
  if (
    before.from > 0 &&
    /[a-zA-Z0-9._@-]/.test(context.state.sliceDoc(before.from - 1, before.from))
  )
    return null
  try {
    const query = before.text.slice(1)
    const { users } = await api.users(query, shortId)
    const options = users
      // Source mentions wake people; @derive and registered agents remain intentionally
      // thread-only until source mentions have a canonical reply surface.
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
    // Directory search is an affordance; raw @handles still publish safely if it is unavailable.
    return null
  }
}

// Syntax colors ride the semantic CSS variables instead of hard-coded values, so
// the highlight follows the active theme (dark and light) with a single style.
const tokenHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.tagName], color: "var(--primary)" },
  { tag: t.string, color: "var(--success)" },
  { tag: [t.number, t.atom], color: "var(--warning)" },
  { tag: t.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: t.heading, color: "var(--foreground)", fontWeight: "600" },
  { tag: t.strong, color: "var(--foreground)", fontWeight: "600" },
  { tag: [t.link, t.url], color: "var(--primary)", textDecoration: "underline" },
  {
    tag: [t.punctuation, t.operator, t.processingInstruction],
    color: "var(--muted-foreground)",
  },
  { tag: [t.propertyName, t.attributeName], color: "var(--foreground)" },
])

/**
 * A thin CodeMirror 6 wrapper for the source editor: syntax highlighting for
 * markdown or HTML, line numbers, soft-wrap. Mounted imperatively (CM owns its
 * own DOM); React only feeds it the value and reads changes back. Loaded lazily
 * by SourceEditor so CodeMirror never lands in the main bundle.
 */
export function CodeEditor({
  value,
  format,
  onChange,
  placeholder,
  shortId,
}: {
  value: string
  format: "md" | "html"
  onChange: (v: string) => void
  /** First-use hint shown in the empty editor (the /new flow); omitted when editing. */
  placeholder?: string
  /** The existing artifact scopes people search to its collaborators. New docs use the active
   * workspace directory; the publish-time gate remains the authority in both cases. */
  shortId?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // Keep the latest onChange without re-creating the editor each render.
  const cb = useRef(onChange)
  cb.current = onChange

  // (Re)create the editor when the language changes. The doc is seeded from the
  // current value; subsequent external value changes are synced in the effect below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` seeds the initial doc only; live syncing is handled separately to avoid clobbering the cursor.
  useEffect(() => {
    if (!host.current) return
    const view_ = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          // A curated set instead of CodeMirror's basicSetup: the editing niceties
          // (line numbers, active line, undo, bracket matching, syntax highlight,
          // indent-on-input) without search / lint / folding. @mention completion is the one
          // exception: it makes a live-body handoff discoverable and writes a portable handle.
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(tokenHighlight, { fallback: true }),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          autocompletion({ override: [sourceMentionCompletions(shortId)] }),
          format === "md" ? markdown() : html(),
          ...(placeholder ? [cmPlaceholder(placeholder)] : []),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current(u.state.doc.toString())
          }),
          EditorView.theme({
            "&": {
              height: "100%",
              backgroundColor: "transparent",
              fontSize: "13px", // tokens-ignore: CodeMirror raw-CSS theme; editor font px, not a design token
            },
            // Editable focus grammar: no outline, soft ink glow via the ring token.
            "&.cm-focused": {
              outline: "none",
              boxShadow: "0 0 0 2px color-mix(in oklab, var(--ring) 40%, transparent)",
            },
            ".cm-scroller": {
              fontFamily: "var(--font-mono)",
              lineHeight: "1.65",
              padding: "8px 0",
            },
            ".cm-gutters": { backgroundColor: "transparent", border: "none", opacity: "0.55" },
            ".cm-content": { padding: "0 4px" },
          }),
        ],
      }),
    })
    view.current = view_
    return () => {
      view_.destroy()
      view.current = null
    }
  }, [format, shortId])

  // Sync external value changes (initial load, programmatic resets) without
  // disturbing the user mid-type: only dispatch when the value truly differs.
  useEffect(() => {
    const v = view.current
    if (v && value !== v.state.doc.toString()) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
    }
  }, [value])

  return (
    <div
      ref={host}
      data-testid="artifact-source-editor"
      className="h-full min-h-0 flex-1 overflow-hidden"
    />
  )
}

export default CodeEditor

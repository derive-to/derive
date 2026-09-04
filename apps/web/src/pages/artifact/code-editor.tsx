import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { html } from "@codemirror/lang-html"
import { markdown } from "@codemirror/lang-markdown"
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language"
// LaTeX has no Lezer grammar; the legacy stream mode is small and lives in this lazy chunk.
import { stex } from "@codemirror/legacy-modes/mode/stex"
import { EditorState, StateEffect } from "@codemirror/state"
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
  format: "md" | "html" | "tex"
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
          format === "md" ? markdown() : format === "tex" ? StreamLanguage.define(stex) : html(),
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
    // Directory lookup is valuable once a writer starts composing a mention, but
    // CodeMirror is already our largest lazy chunk. Load its completion grammar
    // separately so opening source keeps its existing performance budget; the
    // editor stays fully usable if that optional affordance cannot load.
    void import("./source-mention-completion")
      .then(({ sourceMentionCompletion }) => {
        if (view.current !== view_) return
        view_.dispatch({ effects: StateEffect.appendConfig.of(sourceMentionCompletion(shortId)) })
      })
      .catch(() => {
        // Source editing remains safe and publishable without the optional picker.
      })
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

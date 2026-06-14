import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { html } from "@codemirror/lang-html"
import { markdown } from "@codemirror/lang-markdown"
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language"
import { EditorState } from "@codemirror/state"
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view"
import { useEffect, useRef } from "react"

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
}: {
  value: string
  format: "md" | "html"
  onChange: (v: string) => void
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
          // indent-on-input) without autocomplete / search / lint / folding — keeps
          // this lazy chunk lighter, which matters on a phone.
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          format === "md" ? markdown() : html(),
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
            "&.cm-focused": { outline: "none" },
            ".cm-scroller": {
              fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
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
  }, [format])

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

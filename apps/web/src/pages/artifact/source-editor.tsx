import { lazy, Suspense, useEffect, useState } from "react"
import { api } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

// CodeMirror (+ the markdown renderer the preview pulls in) load only when the
// editor opens, so they never weigh on the main bundle.
const CodeEditor = lazy(() => import("./code-editor"))

/**
 * The full-screen source editor: edit on the left, a live preview on the right
 * that re-renders as you type. Markdown is rendered through the *same*
 * renderMarkdown the server uses, so the preview is exactly what publishes; HTML
 * is shown raw. Editors publish a new version directly (with an optional commit
 * message); commenters submit the edit as a proposal with a "why". On phones the
 * two panes collapse to an Edit / Preview toggle.
 */
export function SourceEditor({
  canPublish,
  title,
  format,
  src,
  message,
  proposeMsg,
  onSrc,
  onMessage,
  onProposeMsg,
  onCancel,
  onPublish,
  onPropose,
}: {
  canPublish: boolean
  title: string
  format: "md" | "html"
  src: string
  message: string
  proposeMsg: string
  onSrc: (v: string) => void
  onMessage: (v: string) => void
  onProposeMsg: (v: string) => void
  onCancel: () => void
  onPublish: () => void
  onPropose: () => void
}) {
  const [pane, setPane] = useState<"edit" | "preview">("edit")
  const [preview, setPreview] = useState("")

  // Debounced, faithful preview. HTML renders in-browser as-is; markdown is
  // rendered by the server's real renderer (the same one publish uses), so what
  // you see is exactly what ships.
  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      if (format === "html") {
        setPreview(src)
        return
      }
      api
        .renderPreview(src, title)
        .then(({ html }) => {
          if (!cancelled) setPreview(html)
        })
        .catch(() => {})
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [src, format, title])

  const tab = (id: "edit" | "preview", label: string) => (
    <button
      type="button"
      data-testid={`artifact-${id}-tab`}
      onClick={() => setPane(id)}
      className={cn(
        "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
        pane === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground",
      )}
    >
      {label}
    </button>
  )

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border-soft px-4 py-2.5">
        <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <Icon name="edit" size={16} />
          <span className="max-w-[40vw] truncate">
            {canPublish ? `Editing · ${title}` : "Proposing a change"}
          </span>
        </span>
        {canPublish ? (
          <Input
            value={message}
            onChange={(e) => onMessage(e.target.value)}
            placeholder="Describe this version (optional)"
            data-testid="artifact-commit-message"
            className="h-8 min-w-[140px] max-w-[360px] flex-1 text-sm"
          />
        ) : (
          <Input
            value={proposeMsg}
            onChange={(e) => onProposeMsg(e.target.value)}
            placeholder="What are you changing, and why?"
            data-testid="artifact-propose-message"
            className="h-8 min-w-[140px] max-w-[420px] flex-1 text-sm"
          />
        )}
        <span className="ml-auto flex items-center gap-2">
          {/* Phone: one pane at a time. Desktop shows both, so the toggle hides. */}
          <span className="flex rounded-lg border border-border bg-muted/50 p-0.5 md:hidden">
            {tab("edit", "Edit")}
            {tab("preview", "Preview")}
          </span>
          <Button variant="outline" size="sm" data-testid="artifact-edit-cancel" onClick={onCancel}>
            Cancel
          </Button>
          {canPublish ? (
            <Button
              variant="primary"
              size="sm"
              data-testid="artifact-publish-version"
              onClick={onPublish}
            >
              Publish
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              data-testid="artifact-propose-submit"
              onClick={onPropose}
            >
              Propose
            </Button>
          )}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className={cn("min-h-0 flex-1 flex-col md:flex", pane === "edit" ? "flex" : "hidden")}>
          <Suspense
            fallback={
              <textarea
                value={src}
                onChange={(e) => onSrc(e.target.value)}
                spellCheck={false}
                data-testid="artifact-source-editor"
                className="h-full flex-1 resize-none border-0 bg-card px-5 py-4 font-mono text-sm leading-relaxed text-foreground outline-none"
              />
            }
          >
            <CodeEditor value={src} format={format} onChange={onSrc} />
          </Suspense>
        </div>
        <div
          className={cn(
            "min-h-0 flex-1 flex-col bg-white md:flex md:border-l md:border-border-soft",
            pane === "preview" ? "flex" : "hidden",
          )}
        >
          <iframe
            title="Live preview"
            data-testid="artifact-preview"
            srcDoc={preview}
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
            className="h-full w-full flex-1 border-0 bg-white"
          />
        </div>
      </div>
    </div>
  )
}

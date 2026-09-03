import { lazy, Suspense, useEffect, useState } from "react"
import { api } from "@/api"
import { Icon } from "@/components/icons"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { skillPreviewSource } from "@/lib/skill-source"
import { cn } from "@/lib/utils"

// CodeMirror (+ the markdown renderer the preview pulls in) load only when the
// editor opens, so they never weigh on the main bundle.
const CodeEditor = lazy(() => import("./code-editor"))

/**
 * The source editor: edit on the left, a live preview on the right that
 * re-renders as you type. Renders in-flow in the document column (the app sidebar
 * + the comments panel stay, so you can reference comments while editing), not as
 * a fullscreen overlay. Markdown is rendered through the *same* renderMarkdown the
 * server uses, so the preview is exactly what publishes; HTML is shown raw.
 * Editors publish a new version directly (with an optional commit message). On
 * phones the two panes collapse to an Edit / Preview toggle.
 */
export function SourceEditor({
  title,
  format,
  src,
  message,
  onSrc,
  onMessage,
  onCancel,
  onPublish,
  onTitle,
  placeholder,
  publishing,
  shortId,
  stripFrontmatter = false,
}: {
  title: string
  format: "md" | "html"
  src: string
  message: string
  onSrc: (v: string) => void
  onMessage: (v: string) => void
  onCancel: () => void
  onPublish: () => void
  // When set, the title becomes an editable field (the new-artifact flow at /new);
  // omitted for editing an existing artifact, where the title is shown read-only.
  onTitle?: (v: string) => void
  // First-use hint for the empty editor (the /new flow); omitted when editing.
  placeholder?: string
  // True while the parent's publish mutation is in flight — disables the toolbar
  // buttons and shows a spinner, so a double-click can't duplicate a version.
  publishing?: boolean
  /** Existing artifact id used to scope the source editor's @mention directory. */
  shortId?: string
  /** Skill metadata lives in YAML frontmatter but the published reader intentionally
   *  hides it. Remove that block from the live preview while keeping it editable. */
  stripFrontmatter?: boolean
}) {
  const [pane, setPane] = useState<"edit" | "preview">("edit")
  // Desktop preview-pane visibility (mobile uses the Edit/Preview tabs instead).
  const [previewOpen, setPreviewOpen] = useState(true)
  const [preview, setPreview] = useState("")
  // True when the last render failed: the pane still shows the previous good HTML,
  // so flag it stale rather than silently freezing on an out-of-date preview.
  const [previewStale, setPreviewStale] = useState(false)

  // Debounced, faithful preview. HTML renders in-browser as-is; markdown is
  // rendered by the server's real renderer (the same one publish uses), so what
  // you see is exactly what ships. Skipped while the preview is hidden so we don't
  // render on every keystroke for nothing.
  useEffect(() => {
    if (!previewOpen) return
    let cancelled = false
    const t = setTimeout(() => {
      if (format === "html") {
        setPreview(src)
        setPreviewStale(false)
        return
      }
      const previewSource = stripFrontmatter ? skillPreviewSource(src) : src
      api
        .renderPreview(previewSource, title)
        .then(({ html }) => {
          if (!cancelled) {
            setPreview(html)
            setPreviewStale(false)
          }
        })
        .catch(() => {
          // Keep the last good preview on screen, but mark it stale so the writer
          // knows their latest edit didn't render (network blip / render error).
          if (!cancelled) setPreviewStale(true)
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [src, format, title, previewOpen, stripFrontmatter])

  return (
    // In-flow (fills the document column), not a fullscreen overlay: the app
    // sidebar stays, and the comments panel toggles in/out beside the editor just
    // like in normal viewing — so you can reference comments while editing.
    <div className="flex min-h-0 flex-1 flex-col bg-card">
      {/* Toolbar canon: matches the view bar in index.tsx (px-4 py-2 border-border). */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        {onTitle ? (
          <Input
            value={title}
            onChange={(e) => onTitle(e.target.value)}
            placeholder="Untitled"
            aria-label="Title"
            data-testid="artifact-title-input"
            className="font-medium md:w-auto md:max-w-80 md:flex-1"
          />
        ) : (
          <span className="flex items-center gap-2 font-mono text-2xs text-muted-foreground">
            <Icon name="edit" size={16} />
            <span className="max-w-[40vw] truncate">{`Editing · ${title}`}</span>
          </span>
        )}
        <Input
          value={message}
          onChange={(e) => onMessage(e.target.value)}
          placeholder="Describe this version (optional)"
          aria-label="Version description"
          data-testid="artifact-commit-message"
          className="order-last md:order-none md:w-auto md:max-w-90 md:flex-1"
        />
        <span className="ml-auto flex items-center gap-2">
          {/* Desktop: show/hide the preview for a full-width editor when you don't
              need it. (Phones use the Edit/Preview tabs below instead.) */}
          <Button
            variant="outline"
            size="sm"
            data-testid="artifact-preview-toggle"
            onClick={() => setPreviewOpen((value) => !value)}
            title={previewOpen ? "Hide preview" : "Show preview"}
            aria-pressed={previewOpen}
            // Pressed toggles are a neutral wash — the ink accent is reserved.
            className={cn("hidden gap-1.5 md:inline-flex", previewOpen && "bg-accent")}
          >
            <Icon name="views" size={16} />
            Preview
          </Button>
          {/* Phone: one pane at a time — the shared compact segmented control. */}
          <Tabs
            value={pane}
            onValueChange={(v) => setPane(v as "edit" | "preview")}
            className="md:hidden"
          >
            <TabsList size="sm">
              <TabsTrigger value="edit" data-testid="artifact-edit-tab">
                Edit
              </TabsTrigger>
              <TabsTrigger value="preview" data-testid="artifact-preview-tab">
                Preview
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            variant="outline"
            size="sm"
            data-testid="artifact-edit-cancel"
            onClick={onCancel}
            disabled={publishing}
          >
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            data-testid="artifact-publish-version"
            loading={publishing}
            onClick={onPublish}
          >
            Publish
          </Button>
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
                aria-label="Artifact source"
                data-testid="artifact-source-editor"
                placeholder={placeholder}
                className="h-full flex-1 resize-none border border-input bg-card px-5 py-4 font-mono text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            }
          >
            <CodeEditor
              value={src}
              format={format}
              onChange={onSrc}
              placeholder={placeholder}
              shortId={shortId}
            />
          </Suspense>
        </div>
        <div
          className={cn(
            "min-h-0 flex-1 flex-col bg-white md:border-l md:border-border-soft",
            pane === "preview" ? "flex" : "hidden",
            previewOpen ? "md:flex" : "md:hidden",
          )}
        >
          {previewStale && (
            // StatusPanel doesn't spread extra props, so the testid rides a wrapper.
            <div data-testid="preview-stale" className="shrink-0">
              <StatusPanel
                tone="warning"
                layout="inline"
                title="Preview unavailable"
                description="Showing your last successful render."
                // A compact edge-to-edge strip in the editor chrome, not a floating card.
                className="rounded-none p-2.5"
              />
            </div>
          )}
          <iframe
            title="Live preview"
            data-testid="artifact-preview"
            srcDoc={preview}
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
            className="size-full flex-1 border-0 bg-white"
          />
        </div>
      </div>
    </div>
  )
}

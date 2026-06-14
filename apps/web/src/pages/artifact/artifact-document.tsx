import type { RefObject } from "react"
import type { Diff } from "@/api"
import { Button } from "@/components/ui/button"
import { DiffView } from "./diff-view"
import { DeckBar } from "./rail-deck"

/**
 * The document surface: a history banner when viewing a past version, then either
 * the line diff or the sandboxed iframe (with the live-cursor overlay + the deck
 * bar for slide artifacts). The refs are owned by the page (its anchor/presence/
 * fullscreen effects drive them) and passed in.
 */
export function ArtifactDocument({
  shown,
  currentVersion,
  title,
  rawSrc,
  view,
  diff,
  restoring,
  deck,
  frameRef,
  presentWrapRef,
  cursorLayerRef,
  onFrameLoad,
  onToggleDiff,
  onRestore,
  onBackToCurrent,
  onDeckPrev,
  onDeckNext,
  onFullscreen,
}: {
  shown: number
  currentVersion: number
  title: string
  rawSrc: string
  view: "preview" | "diff"
  diff: Diff | null
  restoring: boolean
  deck: { i: number; total: number } | null
  frameRef: RefObject<HTMLIFrameElement | null>
  presentWrapRef: RefObject<HTMLDivElement | null>
  cursorLayerRef: RefObject<HTMLDivElement | null>
  onFrameLoad: () => void
  onToggleDiff: () => void
  onRestore: () => void
  onBackToCurrent: () => void
  onDeckPrev: () => void
  onDeckNext: () => void
  onFullscreen: () => void
}) {
  const past = shown !== currentVersion
  return (
    <>
      {/* History-viewing banner: only when looking at a past version. The current
          version just shows the artifact, no version chrome. */}
      {past && (
        <div className="flex flex-wrap items-center gap-2.5 gap-y-1.5 border-b border-border-soft bg-accent px-3.5 py-2 text-sm">
          <span className="font-semibold text-primary">Viewing an earlier version</span>
          <span className="text-muted-foreground">·</span>
          <button
            type="button"
            data-testid="artifact-toggle-diff"
            className="text-primary underline underline-offset-2 hover:opacity-80"
            onClick={onToggleDiff}
          >
            {view === "diff" ? "Hide changes" : "Show changes since this"}
          </button>
          <span className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            data-testid="artifact-restore"
            onClick={onRestore}
            disabled={restoring}
          >
            {restoring ? "Restoring…" : "Restore this version"}
          </Button>
          <Button
            variant="primary"
            size="sm"
            data-testid="artifact-back-to-current"
            onClick={onBackToCurrent}
          >
            Back to current
          </Button>
        </div>
      )}
      {view === "diff" && past ? (
        <DiffView diff={diff} fromLabel={`v${shown}`} toLabel="current" />
      ) : (
        <div ref={presentWrapRef} className="relative flex min-h-0 flex-1 flex-col bg-white">
          <iframe
            ref={frameRef}
            onLoad={onFrameLoad}
            title={title}
            src={rawSrc}
            allow="fullscreen"
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            className="flex-1 border-0 bg-white"
          />
          {deck && (
            <DeckBar deck={deck} onPrev={onDeckPrev} onNext={onDeckNext} onFullscreen={onFullscreen} />
          )}
          {/* Live peer cursors (Google-Docs style). The iframe is a separate opaque
              origin, so its anchor script forwards mousemove out via postMessage; we
              paint the dots here in the parent, over the frame. Anon viewers too. */}
          <div
            ref={cursorLayerRef}
            className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
          />
        </div>
      )}
    </>
  )
}

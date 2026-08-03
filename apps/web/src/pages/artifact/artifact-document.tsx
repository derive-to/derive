import type { RefObject } from "react"
import type { Diff } from "@/api"
import { Button } from "@/components/ui/button"
import { CursorLayer } from "./cursors/cursor-layer"
import type { CursorLayerHandle } from "./cursors/use-live-cursors"
import { DiffView } from "./diff-view"
import { DeckBar } from "./rail-deck"
import { RenderStage } from "./render-stage"
import type { Deck } from "./types"

/**
 * The document surface: a past-version banner when off the live version, then the
 * line diff or the matted live render (RenderStage owns the sandboxed iframe + its
 * boot/failure states; the deck bar and live-cursor overlay ride inside the mat).
 * The refs are owned by the page (its anchor/presence/fullscreen effects drive
 * them) and threaded in.
 */
export function ArtifactDocument({
  shown,
  currentVersion,
  title,
  subject,
  rawSrc,
  view,
  diff,
  diffFailed,
  onDiffRetry,
  restoring,
  deck,
  frameRef,
  presentWrapRef,
  cursor,
  onScrollDoc,
  onFrameLoad,
  onToggleDiff,
  onRestore,
  onBackToCurrent,
  onDeckPrev,
  onDeckNext,
  presenting = false,
  presentOverlay = false,
  controlsIdle = false,
  onPresent,
  anonView = false,
}: {
  shown: number
  currentVersion: number
  title: string
  /** The artifact's short id — keys the render stage's Updated cue. */
  subject: string
  /** null = the record is still a list-row seed (no raw_token yet) — RenderStage
   *  holds its boot state and mounts the frame once the real source arrives. */
  rawSrc: string | null
  view: "preview" | "diff"
  diff: Diff | null
  diffFailed?: boolean
  onDiffRetry?: () => void
  restoring: boolean
  deck: Deck | null
  frameRef: RefObject<HTMLIFrameElement | null>
  presentWrapRef: RefObject<HTMLDivElement | null>
  cursor: CursorLayerHandle
  onScrollDoc: (dy: number) => void
  onFrameLoad: () => void
  onToggleDiff: () => void
  onRestore: () => void
  onBackToCurrent: () => void
  onDeckPrev: () => void
  onDeckNext: () => void
  /** Present mode is up: the stage is the whole screen and the comment/cursor
   *  layers step aside. */
  presenting?: boolean
  /** Presenting WITHOUT the Fullscreen API (iOS Safari refuses it outside video) —
   *  the stage lays itself over the viewport instead. */
  presentOverlay?: boolean
  /** No input for a beat: the presentation controls fade out of the way. */
  controlsIdle?: boolean
  onPresent?: () => void
  /** Anonymous public viewer: the past-version strip keeps only "Back to current"
   *  (diff and restore are workbench affordances an anon caller can't use). */
  anonView?: boolean
}) {
  const past = shown !== currentVersion
  return (
    <>
      {/* Off the live version: a brand-tinted strip (the sync-chip grammar — being
          off-current is a "this matters" moment, not a status warning). */}
      {past && (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-primary/30 bg-primary/5 px-4 py-2 text-sm">
          <span className="font-medium text-primary">
            Viewing an earlier version{anonView ? ` (v${shown})` : ""}
          </span>
          {!anonView && (
            <>
              <span className="text-muted-foreground">·</span>
              <Button
                variant="link"
                data-testid="artifact-toggle-diff"
                className="h-auto p-0 underline"
                onClick={onToggleDiff}
              >
                {view === "diff" ? "Hide changes" : "Show changes since this"}
              </Button>
            </>
          )}
          <span className="flex-1" />
          {!anonView && (
            <Button
              variant="outline"
              size="sm"
              data-testid="artifact-restore"
              onClick={onRestore}
              disabled={restoring}
            >
              {restoring ? "Restoring…" : "Restore this version"}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            data-testid="artifact-back-to-current"
            onClick={onBackToCurrent}
          >
            {anonView ? `Back to current (v${currentVersion})` : "Back to current"}
          </Button>
        </div>
      )}
      {view === "diff" && past ? (
        <DiffView
          diff={diff}
          failed={diffFailed}
          onRetry={onDiffRetry}
          fromLabel={`v${shown}`}
          toLabel="current"
        />
      ) : (
        <RenderStage
          rawSrc={rawSrc}
          title={title}
          subject={subject}
          version={shown}
          frameRef={frameRef}
          wrapRef={presentWrapRef}
          onFrameLoad={onFrameLoad}
          overlay={presentOverlay}
          overlays={
            <>
              {deck && onPresent && (
                <DeckBar
                  deck={deck}
                  presenting={presenting}
                  idle={controlsIdle}
                  onPrev={onDeckPrev}
                  onNext={onDeckNext}
                  onPresent={onPresent}
                />
              )}
              {/* Live peer cursors ease in here, over the framed render (the iframe is
                  a separate opaque origin — its script forwards pointer moves out via
                  postMessage). Anon viewers too. Not while presenting: a peer's arrow
                  sliding across a projected slide is someone else's cursor on your
                  screen, in front of a room. */}
              {!presenting && <CursorLayer layer={cursor} onScrollDoc={onScrollDoc} />}
            </>
          }
        />
      )}
    </>
  )
}

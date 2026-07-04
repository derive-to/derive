import { Maximize2 } from "lucide-react"
import { useState } from "react"
import type { GeneralRole, Role } from "@/api"
import { Icon } from "@/components/icons"
import { CollectionsDialog, TagsDialog } from "@/components/shared/organize-dialogs"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { ReportDialog, StarButton } from "./header-actions"
import { ShareButton } from "./share-dialog"

/**
 * The right side of the workbench header (signed-in viewers only). Grouped by spacing,
 * not rules — two clusters read left → right by hierarchy:
 *   [ Share · ★ · ⋯ ]        [ comments ]
 *     actions cluster          the discussion panel toggle (terminal)
 * The filled-ink Share leads as the one primary; the favorited star is glanceable
 * state; the ⋯ holds everything else (Reader/Present, Tags/Collections, Insights/
 * History/Proposals, Edit/Lock/Report). Comments hugs the panel it opens. Presence +
 * the cursor picker are the ambient cluster the page renders ahead of this. Props-
 * driven; the page keeps the cache writes.
 */
export function ArtifactTopBar(props: {
  shortId: string
  myRole?: Role | null
  visibility: string
  generalRole?: GeneralRole
  favorite: boolean
  tags: string[]
  collections: string[]
  canEditTags: boolean
  openProposals: number
  proposalsTotal: number
  isMobile: boolean
  panelOpen: boolean
  openCount: number
  showEdit: boolean
  editLabel: string
  /** This artifact is a slide deck — offer Present (fullscreen) in the ⋯ menu. */
  isDeck: boolean
  /** Offer the Reader toggle (HTML artifacts only — markdown is already responsive). */
  showReader: boolean
  /** Reader view is currently on (re-renders the artifact clean + responsive). */
  reader: boolean
  onReaderToggle: () => void
  /** Caller may toggle the change-lock (editor/owner). */
  canLock: boolean
  /** Whether the artifact is currently locked (changes go through approval). */
  locked: boolean
  onFavorite: (fav: boolean) => void
  onTags: (tags: string[]) => void
  onCollections: (ids: string[]) => void
  onInsights: () => void
  onHistory: () => void
  onReview: () => void
  onStartEdit: () => void
  onToggleComments: () => void
  onPresent: () => void
  onLockToggle: () => void
  /** Enter focus/hero mode — strip the chrome to just the render. */
  onFocus: () => void
}) {
  const { shortId, openProposals, proposalsTotal } = props
  const [reportOpen, setReportOpen] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [collectionsOpen, setCollectionsOpen] = useState(false)
  return (
    <>
      {/* Actions cluster — the filled Share leads (the one primary), then the favorited
          star (glanceable state), then the overflow. Tight within; the collaboration
          cluster and comments toggle are held apart by spacing, not vertical rules. */}
      <div className="flex items-center gap-0.5">
        <ShareButton
          shortId={shortId}
          myRole={props.myRole}
          visibility={props.visibility}
          generalRole={props.generalRole}
        />
        <StarButton shortId={shortId} favorite={props.favorite} onChange={props.onFavorite} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="More actions"
              data-testid="artifact-more"
              className="relative"
            >
              <Icon name="more" size={16} className="text-muted-foreground" />
              {/* Open proposals waiting on review — the ink unread-dot grammar. */}
              {openProposals > 0 && (
                <span
                  aria-hidden
                  className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
                />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {/* View modes — focus strips the chrome to just the render; a check marks
                the active reader toggle. */}
            <DropdownMenuItem data-testid="artifact-focus" onSelect={props.onFocus}>
              <Maximize2 className="size-4" aria-hidden /> Focus mode
            </DropdownMenuItem>
            {props.showReader && (
              <DropdownMenuItem data-testid="artifact-reader" onSelect={props.onReaderToggle}>
                <Icon name="reader" size={16} /> Reader
                {props.reader && <Icon name="check" size={16} className="ml-auto" />}
              </DropdownMenuItem>
            )}
            {props.isDeck && (
              <DropdownMenuItem data-testid="artifact-present" onSelect={props.onPresent}>
                <Icon name="present" size={16} /> Present
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />

            {/* Organize — open as dialogs. */}
            <DropdownMenuItem data-testid="artifact-tags" onSelect={() => setTagsOpen(true)}>
              <Icon name="tag" size={16} /> Tags
              {props.tags.length > 0 && (
                <span className="ml-auto font-mono text-2xs tabular-nums text-muted-foreground">
                  {props.tags.length}
                </span>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="artifact-collections"
              onSelect={() => setCollectionsOpen(true)}
            >
              <Icon name="collections" size={16} /> Add to collection
              {props.collections.length > 0 && (
                <span className="ml-auto font-mono text-2xs tabular-nums text-muted-foreground">
                  {props.collections.length}
                </span>
              )}
            </DropdownMenuItem>

            {/* Activity. */}
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="artifact-insights" onSelect={props.onInsights}>
              <Icon name="insights" size={16} /> Insights
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="artifact-history" onSelect={props.onHistory}>
              <Icon name="history" size={16} /> Version history
            </DropdownMenuItem>
            {proposalsTotal > 0 && (
              <DropdownMenuItem data-testid="artifact-review" onSelect={props.onReview}>
                <Icon name="review" size={16} />
                {openProposals > 0 ? `Review proposals (${openProposals})` : "Proposals"}
              </DropdownMenuItem>
            )}

            {/* Manage. */}
            {(props.showEdit || props.canLock) && <DropdownMenuSeparator />}
            {props.showEdit && (
              <DropdownMenuItem data-testid="artifact-edit" onSelect={props.onStartEdit}>
                <Icon name="edit" size={16} />
                {props.editLabel}
              </DropdownMenuItem>
            )}
            {props.canLock && (
              <DropdownMenuItem data-testid="artifact-lock" onSelect={props.onLockToggle}>
                <Icon name={props.locked ? "unlock" : "lock"} size={16} />
                {props.locked ? "Unlock changes" : "Lock changes"}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="artifact-report" onSelect={() => setReportOpen(true)}>
              <Icon name="report" size={16} /> Report artifact
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Comments — the discussion panel toggle, terminal (hugs the panel it opens);
          held apart by spacing. On phones the bottom-right FAB owns this. */}
      {!props.isMobile && (
        <Button
          variant="ghost"
          size="sm"
          className={cn("ml-1", props.panelOpen && "bg-accent text-foreground")}
          data-testid="artifact-show-comments"
          onClick={props.onToggleComments}
          aria-label={props.openCount > 0 ? `Comments, ${props.openCount} open` : "Comments"}
          aria-pressed={props.panelOpen}
        >
          <Icon name="comments" size={16} className="text-muted-foreground" />
          {props.openCount > 0 && (
            <span className="font-mono text-2xs tabular-nums text-muted-foreground">
              {props.openCount}
            </span>
          )}
        </Button>
      )}

      {/* Portaled dialogs — invisible until opened from the ⋯ menu. */}
      <TagsDialog
        shortId={shortId}
        tags={props.tags}
        canEdit={props.canEditTags}
        onChange={props.onTags}
        open={tagsOpen}
        onOpenChange={setTagsOpen}
      />
      <CollectionsDialog
        shortId={shortId}
        inCollections={props.collections}
        onChange={props.onCollections}
        open={collectionsOpen}
        onOpenChange={setCollectionsOpen}
      />
      <ReportDialog shortId={shortId} open={reportOpen} onOpenChange={setReportOpen} />
    </>
  )
}

import type { GeneralRole, Role } from "@/api"
import { Icon } from "@/components/icons"
import { ShareButton } from "@/components/ShareDialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { CollectionsMenu, ReportButton, StarButton, TagsMenu } from "./header-actions"

/**
 * The artifact header actions (portaled into the shell top bar): favorite, tags,
 * collections, share, report, the "⋯ More" menu (insights / history / review /
 * edit), and the show-comments button. Shown only to signed-in viewers — an anon
 * visitor gets none of it. Pure + props-driven; the page keeps the cache writes.
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
  /** This artifact is a slide deck — show the Present (fullscreen) button. */
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
  onShowComments: () => void
  onPresent: () => void
  onLockToggle: () => void
}) {
  const { shortId, openProposals, proposalsTotal } = props
  return (
    <>
      <StarButton shortId={shortId} favorite={props.favorite} onChange={props.onFavorite} />
      <TagsMenu
        shortId={shortId}
        tags={props.tags}
        canEdit={props.canEditTags}
        onChange={props.onTags}
      />
      <CollectionsMenu
        shortId={shortId}
        inCollections={props.collections}
        onChange={props.onCollections}
      />
      <ShareButton
        shortId={shortId}
        myRole={props.myRole}
        visibility={props.visibility}
        generalRole={props.generalRole}
      />
      <ReportButton shortId={shortId} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            title="More"
            aria-label="More actions"
            data-testid="artifact-more"
            className={cn(openProposals > 0 && "bg-hover")}
          >
            <Icon name="more" size={18} className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
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
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Reader: re-render a non-responsive HTML artifact as clean, mobile-friendly
          text. A toggle — when on, it's highlighted; tap again for the original. */}
      {props.showReader && (
        <Button
          variant="ghost"
          size="sm"
          className={cn("gap-1.5", props.reader && "bg-hover text-foreground")}
          data-testid="artifact-reader"
          onClick={props.onReaderToggle}
          title={props.reader ? "Show original layout" : "Reader view"}
          aria-label="Reader view"
          aria-pressed={props.reader}
        >
          <Icon name="reader" size={16} className="text-muted-foreground" /> Reader
        </Button>
      )}
      {/* Decks get a one-tap Present (fullscreen) affordance in the chrome, not just
          the small ⛶ on the floating deck bar. */}
      {props.isDeck && (
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          data-testid="artifact-present"
          onClick={props.onPresent}
          title="Present (fullscreen)"
          aria-label="Present"
        >
          <Icon name="present" size={16} className="text-muted-foreground" /> Present
        </Button>
      )}
      {/* On phones the bottom-right FAB opens comments, so the header button would
          just be a redundant extra wrap-row. */}
      {!props.isMobile && !props.panelOpen && (
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          data-testid="artifact-show-comments"
          onClick={props.onShowComments}
          title="Show comments (c)"
          aria-label="Show comments"
        >
          <Icon name="comments" size={16} className="text-muted-foreground" />
          {props.openCount > 0 && <b className="font-bold">{props.openCount}</b>}
        </Button>
      )}
    </>
  )
}

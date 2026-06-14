import type { Role } from "@/api"
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
  onFavorite: (fav: boolean) => void
  onTags: (tags: string[]) => void
  onCollections: (ids: string[]) => void
  onReport: (msg: string) => void
  onInsights: () => void
  onHistory: () => void
  onReview: () => void
  onStartEdit: () => void
  onShowComments: () => void
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
      <ShareButton shortId={shortId} myRole={props.myRole} />
      <ReportButton shortId={shortId} onDone={props.onReport} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            title="More"
            data-testid="artifact-more"
            className={cn(openProposals > 0 && "border-primary text-primary")}
          >
            <Icon name="more" size={18} />
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
        </DropdownMenuContent>
      </DropdownMenu>
      {/* On phones the bottom-right FAB opens comments, so the header button would
          just be a redundant extra wrap-row. */}
      {!props.isMobile && !props.panelOpen && (
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          data-testid="artifact-show-comments"
          onClick={props.onShowComments}
          title="Show comments (c)"
        >
          <Icon name="comments" size={16} />
          {props.openCount > 0 && <b className="font-bold">{props.openCount}</b>}
        </Button>
      )}
    </>
  )
}

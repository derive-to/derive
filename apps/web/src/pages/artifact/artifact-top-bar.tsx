import { Maximize2, MousePointer2Off, Zap } from "lucide-react"
import { useState } from "react"
import type { CollectionGrant, LinkRole, Listed, Role, WorkspaceAccess } from "@/api"
import { Icon } from "@/components/icons"
import { CollectionsDialog } from "@/components/shared/organize-dialogs"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useCursorPref } from "@/ctx"
import { cn } from "@/lib/utils"
import { AutomateDialog } from "./automate-dialog"
import { MoveToWorkspaceDialog, ReportDialog, StarButton } from "./header-actions"
import { ReworkConnectDialog, ReworkMenuItem } from "./rework-menu-item"
import { ShareButton } from "./share-dialog"

/** Actions for signed-in artifact readers. Members receive workspace controls;
 * guests receive copy and only the collaboration granted by the link. */
export function ArtifactTopBar(props: {
  shortId: string
  /** The immutable version currently shown; export must follow the reader, not HEAD. */
  version: number
  /** Feeds the collections picker's "similar title" suggestions. */
  artifactTitle?: string
  /** The artifact's current workspace — threaded to the move dialog so it can
   *  exclude the current workspace from the destination picker. */
  orgId?: string
  myRole?: Role | null
  /** The v2 access triple (see access-model.md). */
  workspaceAccess?: WorkspaceAccess
  linkRole?: LinkRole
  listed?: Listed
  passwordProtected?: boolean
  publicHistory?: boolean
  favorite: boolean
  collections: string[]
  /** Collections whose sharing reaches this artifact — the share dialog's disclosure rows. */
  collectionAccess: CollectionGrant[]
  isMobile: boolean
  panelOpen: boolean
  openCount: number
  /** Activity since the reader's last visit — the ink dot on the closed toggle. */
  unread: number
  isGuest: boolean
  isCopying: boolean
  commentsAvailable: boolean
  showEdit: boolean
  editLabel: string
  /** Inline (click-to-type) editing — the primary edit affordance, shown as a real
   *  button ahead of Share. The ⋯ "Edit source" item stays the raw fallback. */
  showInlineEdit: boolean
  inlineEditLabel: string
  /** This artifact is a slide deck — offer Present (fullscreen) in the ⋯ menu. */
  isDeck: boolean
  videoMoment?: { scene: string; timeMs: number }
  /** Caller may toggle the change-lock (editor/owner). */
  canLock: boolean
  /** Whether the artifact is currently locked (changes go through approval). */
  locked: boolean
  archived: boolean
  canArchive: boolean
  /** Owner-only: may move this artifact to a different workspace. */
  canMove: boolean
  /** BETA: automations are off per workspace. Hidden rather than shown-and-refused, since the
   *  routes 404 either way and a visible item would only offer an action that cannot work.
   *  Passed down rather than queried here: the page already reads workspace settings for the Chat
   *  tab, so both gates come from one fetch. */
  automateBeta: boolean
  onFavorite: (fav: boolean) => void
  onCollections: (ids: string[]) => void
  onInsights: () => void
  onHistory: () => void
  onStartEdit: () => void
  onInlineEdit: () => void
  onToggleComments: () => void
  onPresent: () => void
  /** Open this artifact's current source as an independent draft. */
  onCreateFrom: () => void
  onLockToggle: () => void
  onArchive: () => void
  /** Enter focus/hero mode — strip the chrome to just the render. */
  onFocus: () => void
  onCopy: () => void
}) {
  const { shortId, isGuest } = props
  const { pref: cursorPref, setPref: setCursorPref } = useCursorPref()
  const [reportOpen, setReportOpen] = useState(false)
  const [collectionsOpen, setCollectionsOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [automateOpen, setAutomateOpen] = useState(false)
  const [reworkConnectOpen, setReworkConnectOpen] = useState(false)
  return (
    <>
      {/* Actions cluster — the filled Share leads (the one primary), then the favorited
          star (glanceable state), then the overflow. Tight within; the collaboration
          cluster and comments toggle are held apart by spacing, not vertical rules. */}
      <div className="flex items-center gap-0.5">
        {/* Inline editing leads the cluster as a labeled ghost verb — the calm
            counterpart to the filled Share. Only someone who can publish sees it.
            It is no longer the only way in (`e`, or Edit on a selection), but it
            stays: it's what tells a first-time reader the document is editable. */}
        {props.showInlineEdit ? (
          <Button
            variant="ghost"
            size="sm"
            title={`${props.inlineEditLabel} (e)`}
            data-testid="artifact-inline-edit"
            onClick={props.onInlineEdit}
          >
            <Icon name="pencil" size={16} className="text-muted-foreground" />
            {props.inlineEditLabel}
          </Button>
        ) : null}
        {isGuest ? (
          <Button
            variant="default"
            size="sm"
            data-testid="artifact-make-copy"
            disabled={props.isCopying}
            onClick={props.onCopy}
          >
            {props.isCopying ? "Copying…" : "Make a copy"}
          </Button>
        ) : (
          <ShareButton
            shortId={shortId}
            version={props.version}
            myRole={props.myRole}
            workspaceAccess={props.workspaceAccess}
            linkRole={props.linkRole}
            listed={props.listed}
            passwordProtected={props.passwordProtected}
            publicHistory={props.publicHistory}
            collectionAccess={props.collectionAccess}
            videoMoment={props.videoMoment}
          />
        )}
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
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {/* View modes — focus strips the chrome to just the render. */}
            <DropdownMenuItem data-testid="artifact-focus" onSelect={props.onFocus}>
              <Maximize2 className="size-4" aria-hidden /> Focus mode
            </DropdownMenuItem>
            {props.isDeck && (
              <DropdownMenuItem data-testid="artifact-present" onSelect={props.onPresent}>
                <Icon name="present" size={16} /> Present
              </DropdownMenuItem>
            )}
            {!isGuest && (
              <DropdownMenuItem data-testid="artifact-create-from" onSelect={props.onCreateFrom}>
                <Icon name="derive" size={16} /> Create from this
              </DropdownMenuItem>
            )}
            {/* Opt out of the live-cursor layer: peers vanish and yours stops broadcasting.
                Kept open on toggle so the state reads back; the preference persists per-browser. */}
            <DropdownMenuCheckboxItem
              data-testid="cursor-hide"
              checked={cursorPref.hidden}
              onCheckedChange={(hidden) => setCursorPref({ hidden })}
              onSelect={(e) => e.preventDefault()}
            >
              <MousePointer2Off className="size-4" aria-hidden /> Hide live cursors
            </DropdownMenuCheckboxItem>
            {!isGuest && <DropdownMenuSeparator />}

            {/* Organize — opens as a dialog. */}
            {!isGuest && (
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
            )}

            {/* Apply the Brandprint — the ask-agent handoff scoped to the whole artifact.
                The item brings its own leading separator, so both vanish together when it
                renders nothing (anonymous viewer, pending or failed reads). */}
            {!isGuest && (
              <ReworkMenuItem shortId={shortId} onConnect={() => setReworkConnectOpen(true)} />
            )}

            {/* Activity. */}
            {(!isGuest || props.publicHistory || props.showEdit) && <DropdownMenuSeparator />}
            {!isGuest && (
              <DropdownMenuItem data-testid="artifact-insights" onSelect={props.onInsights}>
                <Icon name="insights" size={16} /> Insights
              </DropdownMenuItem>
            )}
            {(!isGuest || props.publicHistory) && (
              <DropdownMenuItem data-testid="artifact-history" onSelect={props.onHistory}>
                <Icon name="history" size={16} /> Version history
              </DropdownMenuItem>
            )}

            {/* Manage. */}
            {!isGuest && (props.showEdit || props.canLock || props.canArchive) && (
              <DropdownMenuSeparator />
            )}
            {props.showEdit && (
              <DropdownMenuItem data-testid="artifact-edit" onSelect={props.onStartEdit}>
                <Icon name="edit" size={16} />
                {props.editLabel}
              </DropdownMenuItem>
            )}
            {!isGuest && props.canLock && (
              <DropdownMenuItem data-testid="artifact-lock" onSelect={props.onLockToggle}>
                <Icon name={props.locked ? "unlock" : "lock"} size={16} />
                {props.locked ? "Unlock changes" : "Lock changes"}
              </DropdownMenuItem>
            )}
            {!isGuest && props.canArchive && (
              <DropdownMenuItem data-testid="artifact-archive" onSelect={props.onArchive}>
                <Icon name={props.archived ? "undo" : "archive"} size={16} />
                {props.archived ? "Restore to library" : "Archive"}
              </DropdownMenuItem>
            )}
            {!isGuest && props.canMove && (
              <DropdownMenuItem data-testid="artifact-move" onSelect={() => setMoveOpen(true)}>
                <Icon name="move" size={16} /> Move to workspace…
              </DropdownMenuItem>
            )}
            {!isGuest && props.canMove && props.automateBeta && (
              <DropdownMenuItem
                data-testid="artifact-automate"
                onSelect={() => setAutomateOpen(true)}
              >
                <Zap className="size-4" aria-hidden /> Automate…
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
      {!props.isMobile && props.commentsAvailable && (
        <Button
          variant="ghost"
          size="sm"
          className={cn("relative ml-1", props.panelOpen && "bg-accent text-foreground")}
          data-testid="artifact-show-comments"
          onClick={props.onToggleComments}
          aria-label={[
            "Activity",
            props.openCount > 0 ? `${props.openCount} open` : "",
            !props.panelOpen && props.unread > 0 ? `${props.unread} new` : "",
          ]
            .filter(Boolean)
            .join(", ")}
          aria-pressed={props.panelOpen}
        >
          <Icon name="comments" size={16} className="text-muted-foreground" />
          {props.openCount > 0 && (
            <span className="font-mono text-2xs tabular-nums text-muted-foreground">
              {props.openCount}
            </span>
          )}
          {/* Unread carries the ink dot (the bell's grammar); the count stays neutral. */}
          {!props.panelOpen && props.unread > 0 && (
            <span
              aria-hidden
              data-testid="artifact-activity-unread"
              className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary"
            />
          )}
        </Button>
      )}

      {/* Portaled dialogs — invisible until opened from the ⋯ menu. */}
      {!isGuest && (
        <CollectionsDialog
          shortId={shortId}
          artifactTitle={props.artifactTitle}
          inCollections={props.collections}
          onChange={props.onCollections}
          open={collectionsOpen}
          onOpenChange={setCollectionsOpen}
        />
      )}
      <ReportDialog shortId={shortId} open={reportOpen} onOpenChange={setReportOpen} />
      {!isGuest && (
        <>
          <MoveToWorkspaceDialog
            shortId={shortId}
            currentOrgId={props.orgId}
            open={moveOpen}
            onOpenChange={setMoveOpen}
          />
          <ReworkConnectDialog open={reworkConnectOpen} onOpenChange={setReworkConnectOpen} />
          <AutomateDialog shortId={shortId} open={automateOpen} onOpenChange={setAutomateOpen} />
        </>
      )}
    </>
  )
}

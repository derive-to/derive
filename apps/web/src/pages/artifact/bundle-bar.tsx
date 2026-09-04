import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { API_BASE, type Artifact } from "@/api"
import { Icon } from "@/components/icons"
import { Badge, badgeVariants } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { type BundleTreeNode, buildBundleTree } from "@/lib/bundle-tree"
import { useCopy } from "@/lib/clipboard"
import { skillGraphQuery, skillUsageQuery } from "@/lib/queries"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"

// The files the source editor can open by path (mirrors routes/paper-files.ts).
const EDITABLE_FILE = /\.(tex|latex|bib|bbl|sty|cls|bst|txt|md|html?|css|js|json)$/i

// A folder card opens a beat after the pointer arrives, so sweeping the row past a chip
// does not flash every card, and closes a longer beat after it leaves, so the 4 px gap
// between chip and card can be crossed. Both under the 300 ms tooltip delay the app
// already uses, so the card reads as the chip's own detail rather than a second surface.
const HOVER_OPEN_MS = 150
const HOVER_CLOSE_MS = 300

type Bundle = NonNullable<Artifact["bundle"]>
type BundleFile = Bundle["files"][number]

/**
 * Header chrome for a markdown bundle (a skill — entry SKILL.md — or a plain docs
 * folder): a "Skill" badge + declared identity when it's a skill, plus a file tree.
 * The entry doc renders in the iframe below; these chips open the bundle's other
 * files (sibling docs, scripts, references, assets) in a new tab via the raw route.
 * Self-contained — no app state — so it drops in above <ArtifactDocument> without
 * touching the comment/iframe bridge. Renders nothing for a single-file bundle with
 * no skill identity (there'd be nothing to show).
 *
 * A paper bundle passes `onEditFile`: its text chips (a section, the .bib, a style
 * file) then open that file in the source editor instead of a raw tab, the entry gets
 * a chip of its own (the bar stays up while the editor is open, so it is how you move
 * between files), each root folder becomes one chip whose card lists what is inside,
 * and `activePath` marks the file the editor holds.
 */
export function BundleBar({
  bundle,
  shortId,
  version,
  onEdit,
  onEditFile,
  activePath,
}: {
  bundle: Bundle
  shortId: string
  version: number
  onEdit?: () => void
  onEditFile?: (path: string) => void
  activePath?: string | null
}) {
  const fileUrl = (path: string) => `${API_BASE}/raw/${shortId}/v/${version}/${path}`
  // One folder card at a time: the chip opened last wins and the others close, so two
  // cards never stack over the paper.
  const [openFolder, setOpenFolder] = useState<string | null>(null)
  // The entry doc IS the page below; list only the supporting files. A paper is the
  // exception: its entry is a chip too (the one you switch back to from a section).
  const files = bundle.files.filter((f) => f.path !== bundle.entry)
  const tree = onEditFile ? buildBundleTree(bundle.files, bundle.entry) : null
  const chipCount = tree ? tree.length : files.length
  if (!bundle.isSkill && chipCount === 0) return null
  if (bundle.isSkill)
    return (
      <SkillWorkbench
        bundle={bundle}
        shortId={shortId}
        version={version}
        files={files}
        onEdit={onEdit}
      />
    )
  return (
    // Toolbar canon: matches the view bar in index.tsx (px-4 py-2 border-border).
    <div className="flex flex-col gap-2 border-b border-border px-4 py-2" data-testid="bundle-bar">
      {(bundle.isSkill || bundle.name) && (
        <div className="flex flex-wrap items-center gap-2">
          {bundle.isSkill && (
            // The one brand-chip treatment (Badge brand) — no extra border.
            <Badge variant="brand" shape="pill" className="uppercase tracking-wide">
              Skill
            </Badge>
          )}
          {bundle.name && (
            <span className="font-serif text-base font-medium tracking-tight text-foreground">
              {bundle.name}
            </span>
          )}
        </div>
      )}
      {bundle.description && (
        <p className="line-clamp-2 text-sm text-muted-foreground">{bundle.description}</p>
      )}
      {tree && onEditFile ? (
        <div className="flex flex-wrap gap-1.5">
          {tree.map((node) =>
            node.kind === "file" ? (
              <FileChip
                key={node.file.path}
                file={node.file}
                label={node.file.path}
                href={fileUrl(node.file.path)}
                active={node.file.path === activePath}
                onEditFile={onEditFile}
              />
            ) : (
              <FolderChip
                key={node.path}
                folder={node}
                activePath={activePath ?? null}
                fileUrl={fileUrl}
                onEditFile={onEditFile}
                openFolder={openFolder}
                onOpen={setOpenFolder}
              />
            ),
          )}
        </div>
      ) : (
        files.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {files.map((f) => (
              <FileChip
                key={f.path}
                file={f}
                label={f.path}
                href={fileUrl(f.path)}
                active={false}
              />
            ))}
          </div>
        )
      )}
    </div>
  )
}

/**
 * One file chip. Editable text (given `onEditFile`) opens in the source editor; anything
 * else opens raw in a new tab. The active file reads as the selected state: the neutral
 * fill, no hover treatment (a hover must never repaint a selection), and aria-current so
 * assistive tech and the e2e read the same signal. `label` is what the chip shows (the
 * full path at the root); the test id and title always carry the full path.
 */
function FileChip({
  file,
  label,
  href,
  active,
  onEditFile,
}: {
  file: BundleFile
  label: string
  href: string
  active: boolean
  onEditFile?: (path: string) => void
}) {
  if (onEditFile && EDITABLE_FILE.test(file.path))
    return (
      <Badge asChild variant={active ? "default" : "outline"} shape="pill">
        <button
          type="button"
          title={`Edit ${file.path}`}
          aria-current={active ? "true" : undefined}
          className={active ? undefined : "hover:border-foreground/25 hover:text-foreground"}
          onClick={() => onEditFile(file.path)}
          data-testid={`bundle-edit-${file.path}`}
        >
          {label}
        </button>
      </Badge>
    )
  return (
    <Badge asChild variant="outline" shape="pill">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={file.type}
        className="hover:border-foreground/25 hover:text-foreground"
        data-testid={`bundle-open-${file.path}`}
      >
        {label}
      </a>
    </Badge>
  )
}

type FolderNode = Extract<BundleTreeNode, { kind: "folder" }>

const holdsPath = (folder: FolderNode, path: string | null) =>
  path?.startsWith(`${folder.path}/`) ?? false

/**
 * A root folder's chip: the folder glyph, its name and a count, opening a card with the
 * folder's tree. The card opens on hover (a mouse pointer, after a beat) or on keyboard
 * focus, and a click pins it so it survives the pointer leaving; Escape, an outside
 * press or picking a file lets it go. Hover and pin are separate so a pinned card is
 * never closed by the pointer wandering off, and one timer serves both edges of the
 * hover so an arrive-then-leave can never fire twice.
 *
 * The chip reads as selected while it is pinned or holds the open file, and, like a file
 * chip, the selected state carries no hover treatment. Because Radix's trigger would
 * TOGGLE the popover, a click while the card is hover-open would close it; the trigger's
 * own click is taken over (preventDefault skips Radix's toggle) so a click always pins.
 */
function FolderChip({
  folder,
  activePath,
  fileUrl,
  onEditFile,
  openFolder,
  onOpen,
}: {
  folder: FolderNode
  activePath: string | null
  fileUrl: (path: string) => string
  onEditFile: (path: string) => void
  /** The bar's one open folder, so two cards never stack: opening this one is reported
   *  up, and another folder's opening closes this card, pinned or not. */
  openFolder: string | null
  onOpen: (path: string) => void
}) {
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const content = useRef<HTMLDivElement>(null)
  // Radix hands focus back to the trigger when the card closes; that focus must not
  // count as the user arriving on the chip, or Escape would reopen what it just closed.
  const quietFocus = useRef(false)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const open = pinned || hovered
  useEffect(() => {
    if (open) onOpen(folder.path)
  }, [open, folder.path, onOpen])
  // Reacts to the bar's answer only: on the render where this card opens, the bar still
  // names the previous folder (its state lands a render later), so keying on `open` too
  // would close the card the moment it opened.
  useEffect(() => {
    if (openFolder === null || openFolder === folder.path) return
    window.clearTimeout(timer.current)
    setPinned(false)
    setHovered(false)
  }, [openFolder, folder.path])

  const settle = (next: boolean) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setHovered(next), next ? HOVER_OPEN_MS : HOVER_CLOSE_MS)
  }
  const onPointerEnter = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") settle(true)
  }
  const onPointerLeave = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") settle(false)
  }
  const close = () => {
    window.clearTimeout(timer.current)
    setPinned(false)
    setHovered(false)
  }
  const pick = (path: string) => {
    onEditFile(path)
    close()
  }

  const active = pinned || holdsPath(folder, activePath)
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        // Radix asks to close on Escape, an outside press and an iframe click.
        setPinned(o)
        if (!o) close()
      }}
    >
      <PopoverTrigger
        asChild
        onClick={(e) => {
          e.preventDefault()
          if (pinned) {
            close()
            return
          }
          setPinned(true)
          // A keyboard press (click detail 0) while the focus preview is already
          // showing: move into the card, as a fresh open would through Radix.
          if (e.detail === 0 && open)
            content.current?.querySelector<HTMLElement>("button, a[href]")?.focus()
        }}
      >
        <button
          type="button"
          aria-expanded={open}
          data-active={active ? "true" : undefined}
          data-testid={`bundle-folder-${folder.path}`}
          className={cn(
            badgeVariants({ variant: active ? "default" : "outline", shape: "pill" }),
            !active && "hover:border-foreground/25 hover:text-foreground",
          )}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          onFocus={() => {
            if (quietFocus.current) return
            settle(true)
          }}
          onBlur={() => settle(false)}
        >
          <Icon name={open ? "collection-open" : "collection"} size={12} />
          {folder.name}/<span className="text-muted-foreground">{folder.count}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={content}
        align="start"
        sideOffset={4}
        className="w-64 p-1"
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        // A hover-opened card never steals focus; a pinned one takes it like any popover.
        onOpenAutoFocus={(e) => {
          if (!pinned) e.preventDefault()
        }}
        // A hover-opened card follows the pointer, not the focus: when another folder's
        // card closes, Radix hands focus back to that folder's chip, which would read as
        // "focus left this card" and dismiss it in the same breath it opened.
        onFocusOutside={(e) => {
          if (!pinned) e.preventDefault()
        }}
        onCloseAutoFocus={() => {
          // Radix focuses the trigger right after this handler (unless the close came
          // from an outside press); mute the chip's own focus-opens rule for that call.
          quietFocus.current = true
          window.setTimeout(() => {
            quietFocus.current = false
          }, 0)
        }}
      >
        <TreeList nodes={folder.children} activePath={activePath} fileUrl={fileUrl} onPick={pick} />
      </PopoverContent>
    </Popover>
  )
}

/**
 * The mini tree inside a folder card. Twelve rows show per list (28 px each), the rest
 * scroll, so a folder of sixty figures is a card, not a column; a nested folder expands
 * in place, indented one step, with the same cap on its own list.
 */
function TreeList({
  nodes,
  activePath,
  fileUrl,
  onPick,
  nested = false,
}: {
  nodes: BundleTreeNode[]
  activePath: string | null
  fileUrl: (path: string) => string
  onPick: (path: string) => void
  nested?: boolean
}) {
  return (
    <ul
      role={nested ? "group" : "tree"}
      className={cn("max-h-[21rem] overflow-y-auto overscroll-contain", nested && "pl-3")}
    >
      {nodes.map((node) =>
        node.kind === "file" ? (
          <li key={node.file.path}>
            <TreeFile
              node={node}
              open={node.file.path === activePath}
              href={fileUrl(node.file.path)}
              onPick={onPick}
            />
          </li>
        ) : (
          <TreeFolder
            key={node.path}
            folder={node}
            activePath={activePath}
            fileUrl={fileUrl}
            onPick={onPick}
          />
        ),
      )}
    </ul>
  )
}

const TREE_ROW =
  "flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left font-mono text-2xs text-foreground outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"

function TreeFile({
  node,
  open,
  href,
  onPick,
}: {
  node: Extract<BundleTreeNode, { kind: "file" }>
  open: boolean
  href: string
  onPick: (path: string) => void
}) {
  const { path, type } = node.file
  if (EDITABLE_FILE.test(path))
    return (
      <button
        type="button"
        title={path}
        aria-current={open ? "true" : undefined}
        // The open file is the selection; a hover must never repaint it.
        className={cn(TREE_ROW, open ? "bg-accent" : "hover:bg-accent")}
        onClick={() => onPick(path)}
        data-testid={`bundle-tree-${path}`}
      >
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
      </button>
    )
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={path}
      className={cn(TREE_ROW, "hover:bg-accent")}
      data-testid={`bundle-open-${path}`}
    >
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      <span className="shrink-0 text-muted-foreground">{type.replace(/^image\//, "")}</span>
    </a>
  )
}

function TreeFolder({
  folder,
  activePath,
  fileUrl,
  onPick,
}: {
  folder: FolderNode
  activePath: string | null
  fileUrl: (path: string) => string
  onPick: (path: string) => void
}) {
  // The folder holding the open file starts expanded, so the card shows where you are.
  const [open, setOpen] = useState(() => holdsPath(folder, activePath))
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        className={cn(TREE_ROW, "hover:bg-accent")}
        onClick={() => setOpen((o) => !o)}
        data-testid={`bundle-folder-${folder.path}`}
      >
        <Icon name={open ? "collection-open" : "collection"} size={12} />
        <span className="min-w-0 flex-1 truncate">{folder.name}/</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{folder.count}</span>
        <Icon
          name="chevron-right"
          size={12}
          className={cn("text-muted-foreground transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <TreeList
          nodes={folder.children}
          activePath={activePath}
          fileUrl={fileUrl}
          onPick={onPick}
          nested
        />
      )}
    </li>
  )
}

function SkillWorkbench({
  bundle,
  shortId,
  version,
  files,
  onEdit,
}: {
  bundle: Bundle
  shortId: string
  version: number
  files: Bundle["files"]
  onEdit?: () => void
}) {
  const graph = useQuery(skillGraphQuery(shortId))
  const usage = useQuery(skillUsageQuery(shortId))
  const { copied, copy } = useCopy(2000)
  const nodeById = new Map((graph.data?.nodes ?? []).map((node) => [node.id, node]))
  const activeInstalls = (usage.data?.installations ?? []).reduce(
    (sum, item) => sum + item.count,
    0,
  )
  const contextRuns = (usage.data?.contexts ?? []).reduce((sum, item) => sum + item.count, 0)
  const workflowRuns = (usage.data?.workflows ?? []).reduce((sum, item) => sum + item.count, 0)
  const fileUrl = (path: string) => `${API_BASE}/raw/${shortId}/v/${version}/${path}`
  const installCommand = `derive skill add ${shortId}`
  const workflowLinks = (usage.data?.artifacts ?? []).filter(
    (item, index, all) =>
      item.role === "workflow-definition" &&
      item.artifact &&
      all.findIndex((candidate) => candidate.artifact_id === item.artifact_id) === index,
  )

  return (
    <div className="border-b border-border bg-card/60" data-testid="skill-workbench">
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        {bundle.description ? (
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {bundle.description}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Shared instructions for Claude and Codex.</p>
        )}
        <div className="flex shrink-0 flex-wrap gap-2">
          {onEdit ? (
            <Button size="sm" data-testid="skill-edit-source" onClick={onEdit}>
              <Icon name="edit" size={14} /> Edit SKILL.md
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            data-testid="skill-copy-install"
            aria-label={copied ? "Install command copied" : "Copy install command"}
            title="Copies the command that installs this Skill for Claude and Codex"
            onClick={() => void copy(installCommand, { success: "Install command copied" })}
          >
            <Icon name={copied ? "check" : "copy"} />
            {copied ? "Copied" : "Copy install command"}
          </Button>
        </div>
      </div>

      <details className="group border-t border-border-soft" data-testid="skill-details">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <Icon
            name="chevron-right"
            size={13}
            className="transition-transform group-open:rotate-90"
          />
          Details
        </summary>
        <Tabs defaultValue="connections" className="border-t border-border-soft">
          <TabsList
            variant="line"
            className="max-w-full justify-start overflow-x-auto px-4"
            aria-label="Skill details"
          >
            <TabsTrigger value="connections">Connections</TabsTrigger>
            <TabsTrigger value="usage">Usage</TabsTrigger>
            <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
          </TabsList>
          <TabsContent value="connections" className="px-4 py-3">
            {workflowLinks.length ? (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">Linked workflow</span>
                {workflowLinks.map((link) =>
                  link.artifact ? (
                    <Badge key={link.artifact_id} asChild variant="outline" shape="pill">
                      <Link
                        to="/artifacts/$ref"
                        params={{ ref: link.artifact.short_id }}
                        data-testid={`skill-workflow-${link.artifact_id}`}
                      >
                        {link.artifact.title ?? link.artifact.short_id} · v{link.artifact_version}
                      </Link>
                    </Badge>
                  ) : null,
                )}
              </div>
            ) : null}
            {graph.isPending ? (
              <Muted>Loading connections…</Muted>
            ) : graph.isError ? (
              <Muted>Connections couldn’t be loaded.</Muted>
            ) : graph.data.edges.length ? (
              <div className="flex flex-col gap-2">
                {graph.data.edges.map((edge) => {
                  const incoming = edge.target_artifact_id === graph.data.root
                  const connected = nodeById.get(
                    incoming ? edge.source_artifact_id : edge.target_artifact_id,
                  )
                  return (
                    <div
                      key={edge.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm"
                    >
                      <Badge variant="outline" shape="pill">
                        {incoming ? `used by · ${edge.kind}` : edge.kind}
                      </Badge>
                      {connected ? (
                        <Link
                          to="/artifacts/$ref"
                          params={{ ref: connected.short_id }}
                          className="font-medium hover:underline"
                        >
                          {connected.title ?? connected.short_id}
                        </Link>
                      ) : (
                        <span>Unavailable skill</span>
                      )}
                      <span className="ml-auto font-mono text-2xs text-muted-foreground">
                        v{incoming ? edge.source_version : edge.target_version}
                      </span>
                    </div>
                  )
                })}
              </div>
            ) : (
              <Muted>
                This skill stands alone. Link another Skill in SKILL.md, or declare requires,
                extends, or recommends in derive.skill.json.
              </Muted>
            )}
          </TabsContent>
          <TabsContent value="usage" className="px-4 py-3">
            <div className="grid gap-2 sm:grid-cols-3">
              <Metric value={usage.data ? activeInstalls : null} label="active installs" />
              <Metric value={usage.data ? contextRuns : null} label="Context runs" />
              <Metric value={usage.data ? workflowRuns : null} label="Workflow runs" />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              These are separate observed signals. Derive does not guess local activations or
              combine them into a synthetic total.
            </p>
            {usage.isPending ? (
              <Muted>Loading installation details…</Muted>
            ) : usage.data?.installations.length ? (
              <div className="mt-3 flex flex-col gap-2" data-testid="skill-installations">
                <p className="text-xs font-medium text-foreground">Active installations</p>
                {usage.data.installations.map((installation) => (
                  <div
                    key={`${installation.client}:${installation.scope_kind}`}
                    className="flex flex-wrap items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm"
                  >
                    <Badge variant="outline" shape="pill" className="capitalize">
                      {installation.client}
                    </Badge>
                    <Badge variant="outline" shape="pill" className="capitalize">
                      {installation.scope_kind}
                    </Badge>
                    <span>
                      {installation.count} {installation.count === 1 ? "install" : "installs"}
                    </span>
                    <span
                      className="ml-auto text-xs text-muted-foreground"
                      title={new Date(installation.last_synced_at).toLocaleString()}
                    >
                      synced {ago(installation.last_synced_at)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">No active installations yet.</p>
            )}
          </TabsContent>
          <TabsContent value="artifacts" className="px-4 py-3">
            {usage.isPending ? (
              <Muted>Loading linked artifacts…</Muted>
            ) : usage.data?.artifacts.length ? (
              <div className="flex flex-wrap gap-2">
                {usage.data.artifacts.map((item) => (
                  <Badge key={item.id} asChild={!!item.artifact} variant="outline" shape="pill">
                    {item.artifact ? (
                      <Link to="/artifacts/$ref" params={{ ref: item.artifact.short_id }}>
                        {item.artifact.title ?? item.artifact.short_id} · {item.role} · v
                        {item.artifact_version}
                      </Link>
                    ) : (
                      <span>
                        {item.role} · artifact v{item.artifact_version}
                      </span>
                    )}
                  </Badge>
                ))}
              </div>
            ) : (
              <Muted>No artifacts have declared this skill yet.</Muted>
            )}
          </TabsContent>
          <TabsContent value="files" className="px-4 py-3">
            {files.length ? (
              <div className="flex flex-wrap gap-1.5">
                {files.map((file) => (
                  <Badge key={file.path} asChild variant="outline" shape="pill">
                    <a href={fileUrl(file.path)} target="_blank" rel="noopener noreferrer">
                      {file.path}
                    </a>
                  </Badge>
                ))}
              </div>
            ) : (
              <Muted>This skill contains only SKILL.md.</Muted>
            )}
          </TabsContent>
        </Tabs>
      </details>
    </div>
  )
}

function Metric({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="rounded-lg border bg-background px-3 py-2">
      <strong className="font-mono text-base font-medium tabular-nums">{value ?? "—"}</strong>
      <span className="ml-2 text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
      {children}
    </p>
  )
}

import { type ReactNode, useState } from "react"
import { Icon, type IconName } from "@/components/icons"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { EmptyState } from "@/components/shared/empty-state"
import { FormField } from "@/components/shared/form-field"
import { SearchField } from "@/components/shared/search-field"
import { Eyebrow, SectionEyebrow } from "@/components/shared/section-eyebrow"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { ThemeSwitch } from "@/components/theme-switch"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "@/components/ui/sonner"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { getInitials } from "@/lib/initials"
import { cn } from "@/lib/utils"

// /showcase — the design-system reference: the visual language shown through the
// real components it produces, so it can be reviewed and evolved before it touches
// product surfaces. Restraint is the point — a quiet masthead, four groups
// headed by the system's own mono section-label, and every primitive in a plain
// label-left / demo-right list. The accent is monochrome ink; hierarchy comes
// from weight, size, and the neutral surface ramp. Fully token-pure, so it
// doubles as proof the token system is complete. Lives outside
// pages/ + components/shared/ (a design canvas, not a product surface) and renders
// chrome-less (see AppFrame in __root).

/** A reference row: a fixed label column on the left, live examples on the right. */
function Row({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-10 gap-y-4 border-t border-border-soft py-10 md:grid-cols-[180px_minmax(0,1fr)]">
      <div className="md:pt-0.5">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {note ? <p className="mt-1.5 text-sm text-pretty text-muted-foreground">{note}</p> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** A group of rows under one quiet mono heading — the system's own section-label
 *  used to structure the guide itself. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pt-14 first:pt-6">
      <Eyebrow as="h2" className="mb-1.5">
        {title}
      </Eyebrow>
      {children}
    </section>
  )
}

// ── Foundations ───────────────────────────────────────────────────────────────

// The one text face (Geist) across the scale — chrome and voice share it.
const TYPE_SPECIMEN = [
  {
    cls: "text-3xl font-semibold tracking-tight",
    label: "Display · 3xl / semibold",
    sample: "Design system",
  },
  {
    cls: "text-xl font-semibold tracking-tight",
    label: "Title · xl / semibold",
    sample: "Workspace settings",
  },
  {
    cls: "text-base text-foreground",
    label: "Body · base / regular",
    sample: "Share any artifact with a permanent, versioned URL.",
  },
  {
    cls: "text-sm text-muted-foreground",
    label: "Secondary · sm / muted",
    sample: "Published 2 days ago · 3 versions",
  },
]

/** Type — one text face (Geist) shown as it is used: the display "voice" line, the
 *  working chrome scale, and the Geist Mono machine layer for counts + keys. */
function TypeDemo() {
  return (
    <div className="space-y-8">
      <div>
        <Eyebrow>Voice · Geist display</Eyebrow>
        <p className="mt-2 max-w-xl text-2xl font-medium tracking-tight text-balance">
          The permanent home for your AI artifacts.
        </p>
      </div>
      <div>
        <Eyebrow>Chrome · Geist</Eyebrow>
        <div className="mt-3 space-y-3.5">
          {TYPE_SPECIMEN.map((t) => (
            <div
              key={t.label}
              className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1"
            >
              <span className={t.cls}>{t.sample}</span>
              <span className="font-mono text-2xs text-muted-foreground">{t.label}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <Eyebrow>Machine · Geist Mono</Eyebrow>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2.5">
          <span className="font-mono text-2xs tabular-nums text-muted-foreground">
            v3 · updated 2d · 128 views
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>⌘K</Kbd>
            <Kbd>/</Kbd>
          </span>
        </div>
      </div>
    </div>
  )
}

// The neutral surface steps — canvas, raised, floating, well.
const SURFACES = [
  { cls: "bg-background", label: "background" },
  { cls: "bg-card", label: "card" },
  { cls: "bg-popover", label: "popover" },
  { cls: "bg-secondary", label: "secondary" },
]

// The four hues, each with one job. Primary is monochrome ink; safety-orange is
// the warning (a different hue family, so alerts never read as the accent).
const ACCENTS = [
  { cls: "bg-primary", label: "primary · ink" },
  { cls: "bg-success", label: "success" },
  { cls: "bg-warning", label: "warning · safety orange" },
  { cls: "bg-destructive", label: "destructive" },
]

// The calm categorical family (--color-share / -review / …): muted, low-chroma
// tints for data surfaces (categorical charts) and category labels — "not a
// rainbow." Chrome icons stay monochrome; this palette is for content and data.
const TINTS = [
  { cls: "bg-review", label: "review" },
  { cls: "bg-insights", label: "insights" },
  { cls: "bg-collection", label: "collection" },
  { cls: "bg-share", label: "share" },
  { cls: "bg-comments", label: "comments" },
  { cls: "bg-tag", label: "tag" },
  { cls: "bg-gold", label: "gold" },
]

/** Color — the neutral surface ramp, the status hues, and the calm categorical tints. */
function ColorDemo() {
  return (
    <div className="space-y-7">
      <div>
        <Eyebrow>Surfaces</Eyebrow>
        <div className="mt-2.5">
          <div className="flex overflow-hidden rounded-lg border border-border">
            {SURFACES.map((s) => (
              <div key={s.cls} className={cn("h-12 flex-1", s.cls)} />
            ))}
          </div>
          <div className="mt-1.5 flex">
            {SURFACES.map((s) => (
              <span key={s.cls} className="flex-1 font-mono text-2xs text-muted-foreground">
                {s.label}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div>
        <Eyebrow>Status</Eyebrow>
        <div className="mt-3 flex flex-wrap items-center gap-5">
          {ACCENTS.map((a) => (
            <span key={a.label} className="inline-flex items-center gap-2">
              <span className={cn("size-5 rounded-md border border-border-soft", a.cls)} />
              <span className="font-mono text-2xs text-muted-foreground">{a.label}</span>
            </span>
          ))}
        </div>
      </div>
      <div>
        <Eyebrow>Categorical tints</Eyebrow>
        <div className="mt-3 flex flex-wrap items-center gap-5">
          {TINTS.map((t) => (
            <span key={t.label} className="inline-flex items-center gap-2">
              <span className={cn("size-5 rounded-md border border-border-soft", t.cls)} />
              <span className="font-mono text-2xs text-muted-foreground">{t.label}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

// A representative sweep of the one icon vocabulary (lucide, routed through
// components/icons.tsx). Shown at the editorial 24px step.
const ICONS: IconName[] = [
  "all",
  "favorites",
  "following",
  "collections",
  "tag",
  "search",
  "settings",
  "user",
  "workspace",
  "plus",
  "share",
  "comments",
  "star",
  "insights",
  "history",
  "review",
  "pin",
  "views",
  "reader",
  "present",
  "lock",
  "bell",
  "more",
  "edit",
  "react",
  "pencil",
  "link",
  "delete",
]

/** Iconography — the one glyph vocabulary as a quiet catalog, each glyph inheriting
 *  the muted ink and named in mono beneath. */
function IconGridDemo() {
  return (
    <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6">
      {ICONS.map((n) => (
        <div
          key={n}
          className="flex flex-col items-center gap-2.5 rounded-lg py-4 text-muted-foreground"
        >
          <Icon name={n} size={24} strokeWidth={1.75} />
          <span className="font-mono text-2xs">{n}</span>
        </div>
      ))}
    </div>
  )
}

/** Separator — a hairline rule dividing a quiet action row. */
function SeparatorDemo() {
  return (
    <div className="flex h-5 items-center gap-3 text-sm text-muted-foreground">
      <span>Edit</span>
      <Separator orientation="vertical" />
      <span>Share</span>
      <Separator orientation="vertical" />
      <span>Delete</span>
    </div>
  )
}

// ── Controls ──────────────────────────────────────────────────────────────────

/** Buttons — the full variant set, then the size ramp and the two loading states. */
function ButtonsDemo() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <Button variant="default">Publish</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Delete</Button>
        <Button variant="destructive-ghost">Remove</Button>
        <Button variant="success">Approve</Button>
        <Button variant="warning">Request changes</Button>
        <Button variant="link">Link</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <Button variant="secondary" size="sm">
          <Icon name="plus" size={16} /> Small
        </Button>
        <Button variant="secondary" size="default">
          Default
        </Button>
        <Button variant="secondary" size="lg">
          Large
        </Button>
        <Button variant="secondary" disabled>
          Disabled
        </Button>
        {/* loading: current-ink spinner + aria-busy; the label keeps its verb. */}
        <Button variant="default" loading>
          Saving…
        </Button>
        <Button variant="secondary" loading>
          Syncing…
        </Button>
      </div>
    </div>
  )
}

/** Icon buttons — stock Button at size='icon': ghost for toolbars, outline chip. */
function IconButtonsDemo() {
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-xs" aria-label="Share">
          <Icon name="share" className="text-muted-foreground" />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Comment">
          <Icon name="comments" size={16} className="text-muted-foreground" />
        </Button>
        <Button variant="ghost" size="icon" aria-label="More">
          <Icon name="more" size={16} className="text-muted-foreground" />
        </Button>
        <span className="font-mono text-2xs text-muted-foreground">ghost</span>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon-xs" aria-label="Star">
          <Icon name="star" className="text-muted-foreground" />
        </Button>
        <Button variant="outline" size="icon-sm" aria-label="Pin">
          <Icon name="pin" size={16} className="text-muted-foreground" />
        </Button>
        <span className="font-mono text-2xs text-muted-foreground">chip</span>
      </div>
    </div>
  )
}

/** Tabs — the filled neutral wash for panel switches, the line variant whose inked
 *  underline marks the selected tab, and the compact segmented control. */
function TabsDemo() {
  return (
    <div className="flex flex-col gap-7">
      <Tabs defaultValue="preview" className="w-full max-w-md gap-3">
        <TabsList>
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="source">Source</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="preview" className="text-sm text-muted-foreground">
          The rendered artifact, exactly as a reader sees it.
        </TabsContent>
        <TabsContent value="source" className="text-sm text-muted-foreground">
          The raw markdown or HTML behind the render.
        </TabsContent>
        <TabsContent value="history" className="text-sm text-muted-foreground">
          Every published version, newest first.
        </TabsContent>
      </Tabs>
      <Tabs defaultValue="preview" className="w-full max-w-md">
        <TabsList variant="line">
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="source">Source</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
      </Tabs>
      {/* The compact segmented control (size="sm") — theme switch, editor mode. */}
      <Tabs defaultValue="edit" className="w-full max-w-56">
        <TabsList size="sm" className="w-full">
          <TabsTrigger value="edit">Edit</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  )
}

function SegmentedDemo() {
  const [view, setView] = useState<"list" | "folders">("list")
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      aria-label="View"
      value={view}
      onValueChange={(v) => v && setView(v as "list" | "folders")}
    >
      <ToggleGroupItem value="list" aria-label="List">
        <Icon name="all" size={16} />
        List
      </ToggleGroupItem>
      <ToggleGroupItem value="folders" aria-label="Folders">
        <Icon name="collection" size={16} />
        Folders
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

/** View toggle — the single-select ToggleGroup plus the keyboard-hint mono line. */
function ViewToggleDemo() {
  return (
    <div className="flex flex-wrap items-center gap-6">
      <SegmentedDemo />
      <span className="inline-flex items-center gap-1.5 font-mono text-2xs text-muted-foreground">
        Search <Kbd>⌘K</Kbd> · Toggle rail <Kbd>⌘B</Kbd>
      </span>
    </div>
  )
}

/** Badges & status — neutral by default; tonal variants for genuine state; the
 *  mono pill is the one sanctioned rounded-full chip; and the inline status dots. */
function BadgesDemo() {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <Badge variant="default">Draft</Badge>
      <Badge variant="brand">Shared</Badge>
      <Badge variant="success">Published</Badge>
      <Badge variant="warning">Sync stale</Badge>
      <Badge variant="destructive">Failed</Badge>
      <Badge variant="outline">v3</Badge>
      {/* Machine-register pills: mono 2xs, the one sanctioned rounded-full chip. */}
      <Badge shape="pill">Slide 3</Badge>
      <Badge variant="outline" shape="pill">
        v12
      </Badge>
      <Badge variant="brand" shape="pill">
        current
      </Badge>
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="size-1.5 rounded-full bg-success" /> Synced
      </span>
      <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
        <span className="size-1.5 rounded-full bg-destructive" /> Failed
      </span>
    </div>
  )
}

/** Form — labels, fields, helper text, and a single clear primary. */
function FormDemo() {
  return (
    <div className="grid max-w-sm gap-4">
      <FormField label="Title" htmlFor="sc-title">
        <Input id="sc-title" placeholder="Q3 board review" />
      </FormField>
      <FormField label="Description" htmlFor="sc-desc" hint="Shown on the share card.">
        <Textarea id="sc-desc" rows={3} placeholder="A short summary…" />
      </FormField>
      <div className="flex gap-2">
        <Button size="sm" variant="default">
          Save
        </Button>
        <Button size="sm" variant="ghost">
          Cancel
        </Button>
      </div>
    </div>
  )
}

function FormControlsDemo() {
  const [notify, setNotify] = useState(true)
  const [sync, setSync] = useState(false)
  const [plan, setPlan] = useState("pro")
  const [reach, setReach] = useState("team")
  return (
    <div className="grid max-w-sm gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="sc-plan">Plan</Label>
        <Select value={plan} onValueChange={setPlan}>
          <SelectTrigger id="sc-plan" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="free">Free</SelectItem>
            <SelectItem value="pro">Pro</SelectItem>
            <SelectItem value="team">Team</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Label className="flex items-start gap-2.5 font-normal text-foreground">
        <Checkbox
          checked={notify}
          onCheckedChange={(v) => setNotify(v === true)}
          className="mt-0.5"
        />
        <span>
          Email notifications
          <span className="block text-sm text-muted-foreground">On new comments and versions.</span>
        </span>
      </Label>
      <Label className="flex items-center justify-between gap-3 font-normal text-foreground">
        Auto-sync from GitHub
        <Switch checked={sync} onCheckedChange={setSync} />
      </Label>
      <RadioGroup value={reach} onValueChange={setReach} className="gap-1.5">
        <span className="mb-0.5 text-sm font-medium text-foreground">Who can reach it</span>
        {(
          [
            ["team", "Your team"],
            ["link", "Anyone with the link"],
          ] as const
        ).map(([v, txt]) => (
          <Label key={v} className="flex items-center gap-2.5 font-normal text-foreground">
            <RadioGroupItem value={v} />
            {txt}
          </Label>
        ))}
      </RadioGroup>
    </div>
  )
}

// A client-side filter (with the "/" hint) and a server search showing the in-field
// spinner while a fake lookup is in flight.
function SearchFieldDemo() {
  const [filter, setFilter] = useState("")
  const [query, setQuery] = useState("")
  const loading = query.trim().length > 0 && query.trim().length < 4
  return (
    <div className="flex max-w-sm flex-col gap-3">
      <SearchField
        value={filter}
        onValueChange={setFilter}
        placeholder="Filter by title…"
        aria-label="Filter demo items"
        testId="showcase-filter"
        hotkey
      />
      <SearchField
        value={query}
        onValueChange={setQuery}
        placeholder="Search people…"
        aria-label="Search demo people"
        testId="showcase-search"
        loading={loading}
      />
    </div>
  )
}

// ── Surfaces & content ────────────────────────────────────────────────────────

/** A faithful copy of the library artifact card — the app's most-seen surface: a
 *  full-bleed 16:10 render with on-image format + version placards, then a content
 *  block. (The reference shows the gradient placeholder in place of the live frame.) */
function ArtifactCardDemo({
  kind,
  title,
  handle,
  versions,
  comments,
  views,
  starred,
}: {
  kind: { label: string }
  title: string
  handle: string
  versions: number
  comments: number
  views: number
  starred?: boolean
}) {
  return (
    <div className="group relative flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-sm)] transition-shadow duration-150 hover:shadow-[var(--shadow)]">
      <div className="relative aspect-[16/10] overflow-hidden bg-linear-to-br from-accent to-secondary">
        <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex items-center justify-between gap-2">
          <span className="rounded-md bg-scrim/70 px-1.5 py-0.5 font-mono text-2xs text-scrim-foreground ring-1 ring-scrim-foreground/15">
            {kind.label}
          </span>
          {versions > 1 && (
            <span className="ml-auto rounded-md bg-scrim/70 px-1.5 py-0.5 font-mono text-2xs text-scrim-foreground/75 ring-1 ring-scrim-foreground/15">
              v{versions}
            </span>
          )}
        </div>
        <div className="absolute right-2.5 top-2.5 z-20 grid size-7 place-items-center rounded-md border border-border bg-card">
          <Icon
            name="star"
            size={16}
            weight={starred ? "fill" : "regular"}
            className={starred ? "text-primary" : "text-muted-foreground"}
          />
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-2 border-t border-border-soft p-3.5">
        {/* Artifact titles are the work, not the tool — Geist, the voice at display size. */}
        <span className="truncate text-lg font-medium tracking-tight text-foreground">{title}</span>
        <span className="flex items-center gap-2 font-mono text-2xs text-muted-foreground">
          <span>updated 2d</span>
          <span className="ml-auto inline-flex items-center gap-2 tabular-nums">
            <span className="inline-flex items-center gap-1">
              <Icon name="comments" size={12} className="text-muted-foreground" /> {comments}
            </span>
            <span className="inline-flex items-center gap-1">
              <Icon name="views" size={12} className="text-muted-foreground" /> {views}
            </span>
          </span>
        </span>
        <div className="flex items-center gap-2">
          <Avatar className="size-5">
            <AvatarFallback>{getInitials(handle)}</AvatarFallback>
          </Avatar>
          <span className="font-mono text-2xs text-muted-foreground">@{handle}</span>
        </div>
      </div>
    </div>
  )
}

function ArtifactCardsDemo() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <ArtifactCardDemo
        kind={{ label: "Markdown" }}
        title="Q3 board review"
        handle="rob"
        versions={3}
        comments={2}
        views={128}
        starred
      />
      <ArtifactCardDemo
        kind={{ label: "HTML" }}
        title="Launch announcement"
        handle="ana"
        versions={1}
        comments={5}
        views={2140}
      />
    </div>
  )
}

/** A comment row — avatar, identity, body, and the quiet action affordances. */
function CommentDemo() {
  return (
    <div className="max-w-lg">
      <div className="flex gap-3 rounded-lg border border-border bg-card p-4">
        <Avatar className="size-7">
          <AvatarFallback>AL</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-foreground">Ana Lima</span>
            <span className="font-mono text-2xs text-muted-foreground">@ana · 2h</span>
          </div>
          <p className="mt-1 text-sm/6 text-foreground/90">
            The intro reads great — can we tighten the second paragraph before this ships?
          </p>
          <div className="mt-2.5 flex items-center gap-4 text-xs text-muted-foreground">
            <button
              type="button"
              className="rounded-sm outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Reply
            </button>
            <button
              type="button"
              className="rounded-sm outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Resolve
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Avatar — initials fallback across sizes, the workspace soft ink tint, and a
 *  stacked group. Never a solid ink block. */
function AvatarDemo() {
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="flex items-center gap-2.5">
        <Avatar className="size-6">
          <AvatarFallback className="text-2xs">RO</AvatarFallback>
        </Avatar>
        <Avatar className="size-8">
          <AvatarFallback>AL</AvatarFallback>
        </Avatar>
        <Avatar className="size-10">
          <AvatarFallback>JD</AvatarFallback>
        </Avatar>
        <span className="font-mono text-2xs text-muted-foreground">fallback · sizes</span>
      </div>
      <div className="flex items-center gap-2.5">
        <Avatar className="size-8">
          <AvatarFallback className="bg-primary/10 text-primary">DR</AvatarFallback>
        </Avatar>
        <span className="font-mono text-2xs text-muted-foreground">workspace · soft tint</span>
      </div>
      <div className="flex -space-x-2">
        {["AL", "RO", "JD", "MK"].map((s) => (
          <Avatar key={s} className="size-8 ring-2 ring-background">
            <AvatarFallback className="text-2xs">{s}</AvatarFallback>
          </Avatar>
        ))}
      </div>
    </div>
  )
}

/** Section label — the mono smallcaps + hairline rule + tabular count list head. */
function SectionLabelDemo() {
  return (
    <div className="space-y-6">
      <SectionEyebrow count={12} icon={<Icon name="comments" size={12} />}>
        Needs your feedback
      </SectionEyebrow>
      <SectionEyebrow
        count={128}
        action={<span className="font-mono text-2xs text-muted-foreground">Browse all →</span>}
      >
        All artifacts
      </SectionEyebrow>
    </div>
  )
}

const NAV: { icon: IconName; label: string; count?: number }[] = [
  { icon: "all", label: "All", count: 24 },
  { icon: "favorites", label: "Favorites", count: 6 },
  { icon: "following", label: "Following" },
  { icon: "collections", label: "Collections", count: 4 },
]

/** A mini nav rail — the real row grammar: flush on the canvas, rest muted, hover
 *  a neutral wash, active the same neutral wash + re-inked label (no fill, no tick
 *  — the ink weight is the whole active signal). */
function NavDemo() {
  return (
    <div className="flex w-56 flex-col gap-px">
      {NAV.map((r, i) => {
        const active = i === 0
        return (
          <div
            key={r.label}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium",
              active
                ? "bg-foreground/5 text-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <Icon name={r.icon} size={16} />
            <span>{r.label}</span>
            {r.count ? (
              <span className="ml-auto font-mono text-2xs tabular-nums text-muted-foreground">
                {r.count}
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** The artifact toolbar — a segmented version switch plus actions, one primary. */
function ToolbarDemo() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2">
      <div className="flex items-center gap-0.5 rounded-md bg-secondary p-0.5">
        {["v3", "v2", "v1"].map((v, i) => (
          <button
            type="button"
            key={v}
            className={cn(
              "rounded px-2 py-1 font-mono text-2xs outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              i === 0 ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {v}
          </button>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-1">
        <Button size="icon" variant="ghost" aria-label="Share">
          <Icon name="share" size={16} className="text-muted-foreground" />
        </Button>
        <Button size="icon" variant="ghost" aria-label="Comments">
          <Icon name="comments" size={16} className="text-muted-foreground" />
        </Button>
        <Button size="sm" variant="default">
          Publish
        </Button>
      </div>
    </div>
  )
}

/** Empty state — boxless, straight on the canvas: a muted icon, a Geist
 *  headline, one plain line, one quiet action. */
function EmptyStateDemo() {
  return (
    <EmptyState
      icon={<Icon name="collections" strokeWidth={1.75} />}
      title="Nothing here yet."
      description="Publish an artifact from Claude or the CLI and it lands here, versioned and shareable."
      action={
        <Button variant="secondary" size="sm">
          New artifact
        </Button>
      }
    />
  )
}

// ── Overlays & feedback ───────────────────────────────────────────────────────

/** Overlays — tooltip, popover, dropdown menu, dialog, and sheet, each on a
 *  trigger, so the whole floating-surface family is reviewable in one place. */
function OverlaysDemo() {
  return (
    <TooltipProvider>
      <div className="flex flex-wrap items-center gap-2.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm">
              Tooltip
            </Button>
          </TooltipTrigger>
          <TooltipContent>Published 2 days ago</TooltipContent>
        </Tooltip>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              Popover
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64">
            <div className="text-sm font-medium text-foreground">Quick share</div>
            <p className="mt-1 text-sm text-muted-foreground">
              Anyone with the link can view this artifact.
            </p>
          </PopoverContent>
        </Popover>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              Menu
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuItem>
              <Icon name="share" size={16} /> Share
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Icon name="edit" size={16} /> Edit source
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive">
              <Icon name="close" size={16} /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              Dialog
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete artifact?</DialogTitle>
              <DialogDescription>
                This removes “Q3 board review” and its 3 versions. This can't be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost" size="sm">
                  Cancel
                </Button>
              </DialogClose>
              <Button variant="destructive" size="sm">
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm">
              Sheet
            </Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Version history</SheetTitle>
              <SheetDescription>Every published version, newest first.</SheetDescription>
            </SheetHeader>
          </SheetContent>
        </Sheet>
      </div>
    </TooltipProvider>
  )
}

/** Command palette — the ⌘K surface, shown inline (the app mounts it in a dialog).
 *  Selection is controlled empty so cmdk doesn't auto-select its first item and
 *  scrollIntoView() it on mount, which would scroll the page to this section. */
function CommandDemo() {
  return (
    <Command value="" onValueChange={() => {}} className="max-w-md ring-1 ring-foreground/10">
      <CommandInput placeholder="Search artifacts, people, actions…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Artifacts">
          <CommandItem>
            <Icon name="all" size={16} /> Q3 board review
          </CommandItem>
          <CommandItem>
            <Icon name="all" size={16} /> Launch announcement
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="Actions">
          <CommandItem>
            <Icon name="plus" size={16} /> New artifact
          </CommandItem>
          <CommandItem>
            <Icon name="settings" size={16} /> Open settings
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

/** ConfirmDialog — the destructive flow end-to-end: quiet trigger, dialog carries
 *  the gravity, soft-destructive confirm. */
function ConfirmDemo() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="destructive-ghost" size="sm" onClick={() => setOpen(true)}>
        <Icon name="delete" /> Delete artifact
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete this artifact?"
        description="Deletes every version and its comments. This can't be undone."
        confirmLabel="Delete"
        onConfirm={() => {
          toast.success("Artifact deleted")
        }}
      />
    </>
  )
}

/** Status panel — the tinted callout across its tones and both layouts. */
function StatusPanelDemo() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <StatusPanel
        tone="danger"
        title="Couldn't load the library"
        description="This is usually temporary."
      />
      <StatusPanel
        tone="warning"
        title="Sync is falling behind"
        description="GitHub hasn't answered in a while."
      />
      <StatusPanel
        tone="success"
        title="Everything is up to date"
        description="All versions are published."
      />
      <StatusPanel
        tone="brand"
        title="Upgrade to Team"
        description="Invite unlimited collaborators."
      />
      <StatusPanel
        layout="inline"
        tone="warning"
        icon={<Icon name="report" />}
        title="Sync is falling behind"
        description="GitHub hasn't answered in a while. Retry from settings."
        className="sm:col-span-2"
      />
    </div>
  )
}

/** Feedback — toasts (sonner) and skeleton loaders. */
// The loading system: Spinner (actions / short or unknowable waits) in its three
// sizes plus the current-ink tone a busy Button uses, and the redesigned Skeleton
// "breath" shape-matched to a card so nothing shifts when content arrives.
function LoadingDemo() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-6">
        <div className="flex flex-col items-center gap-2">
          <Spinner size="sm" />
          <span className="font-mono text-2xs text-muted-foreground">sm</span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <Spinner />
          <span className="font-mono text-2xs text-muted-foreground">default</span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <Spinner size="lg" />
          <span className="font-mono text-2xs text-muted-foreground">lg</span>
        </div>
        <Button loading>Saving…</Button>
      </div>
      <div className="grid max-w-md gap-5 sm:grid-cols-2">
        <div className="flex flex-col">
          <Skeleton className="aspect-[16/10] rounded-xl" />
          <div className="flex flex-col gap-2.5 px-3.5 pt-3.5">
            <Skeleton className="h-4 w-3/4" />
            <div className="flex items-center gap-1.5">
              <Skeleton className="size-3.5 shrink-0 rounded-full" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="ml-auto h-3 w-10" />
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      </div>
    </div>
  )
}

function FeedbackDemo() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <Button variant="outline" size="sm" onClick={() => toast.success("Artifact published")}>
          Toast · success
        </Button>
        <Button variant="outline" size="sm" onClick={() => toast.error("Couldn't save changes")}>
          Toast · error
        </Button>
        <Button variant="outline" size="sm" onClick={() => toast("New comment from Ana")}>
          Toast · message
        </Button>
      </div>
      <div className="max-w-sm space-y-2.5">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-20 w-full" />
      </div>
    </div>
  )
}

export function Showcase() {
  return (
    <div className="min-h-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto w-full max-w-4xl px-6 py-14 sm:py-20">
        <header className="flex flex-wrap items-start justify-between gap-6 pb-4">
          <div className="max-w-xl">
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className="size-1.5 rounded-full bg-primary" />
              <Eyebrow>Design system · Derive identity</Eyebrow>
            </span>
            <h1 className="mt-5 text-3xl font-medium tracking-tight text-balance sm:text-4xl">
              Two colors, one canvas.
            </h1>
            <p className="mt-4 text-base text-pretty text-muted-foreground">
              The Derive identity on shadcn — a monochrome ink accent on neutral surfaces, one
              typeface, and a calm categorical tint family. Toggle the theme to review both.
            </p>
          </div>
          <ThemeSwitch className="w-40 shrink-0" />
        </header>

        <Group title="Foundations">
          <Row
            title="Type"
            note="One family — Geist Sans carries chrome and voice; Geist Mono carries the machine layer (counts, keys, code)."
          >
            <TypeDemo />
          </Row>
          <Row
            title="Color"
            note="Neutral surfaces with a monochrome ink accent. Safety-orange warns, red is danger, green confirms; the calm tints do feature wayfinding."
          >
            <ColorDemo />
          </Row>
          <Row
            title="Iconography"
            note="One vocabulary — lucide, monochrome, size-4 in the UI. Every glyph inherits the ink beside it."
          >
            <IconGridDemo />
          </Row>
          <Row title="Separator" note="A hairline rule, horizontal or vertical, to divide groups.">
            <SeparatorDemo />
          </Row>
        </Group>

        <Group title="Controls">
          <Row
            title="Buttons"
            note="One filled primary per view; everything else stays quiet. Destructive is a soft red fill — the loud moment is the confirm dialog."
          >
            <ButtonsDemo />
          </Row>
          <Row
            title="Icon buttons"
            note="Stock Button at size='icon' — ghost for toolbars, outline for a card-corner chip."
          >
            <IconButtonsDemo />
          </Row>
          <Row
            title="Tabs"
            note="Filled segments stay a neutral wash; the line variant’s inked underline marks the selected tab."
          >
            <TabsDemo />
          </Row>
          <Row
            title="View toggle"
            note="Stock ToggleGroup — one tab stop, arrow keys move selection; pressed is a neutral wash."
          >
            <ViewToggleDemo />
          </Row>
          <Row
            title="Badges & status"
            note="Neutral by default — tonal variants only for genuine state, and the mono pill is the one sanctioned rounded-full chip."
          >
            <BadgesDemo />
          </Row>
          <Row title="Form" note="Labels, fields, helper text, and a single clear primary.">
            <FormDemo />
          </Row>
          <Row
            title="Form controls"
            note="Stock Radix — select, checkbox, switch, and radio group, each checked in ink."
          >
            <FormControlsDemo />
          </Row>
          <Row
            title="Search"
            note="One anatomy for every field — scent icon, scoped placeholder, “/” hint while empty, one clear affordance, an in-field spinner."
          >
            <SearchFieldDemo />
          </Row>
        </Group>

        <Group title="Surfaces & content">
          <Row
            title="Artifact card"
            note="The most-seen surface. Titles are the work; icons sit muted — only a starred favorite earns the ink fill."
          >
            <ArtifactCardsDemo />
          </Row>
          <Row title="Comment" note="The review loop — identity, body, and low-key actions.">
            <CommentDemo />
          </Row>
          <Row
            title="Avatar"
            note="Initials fallback across sizes, the workspace soft ink tint (never a solid ink block), and a stacked group."
          >
            <AvatarDemo />
          </Row>
          <Row
            title="Section label"
            note="Mono smallcaps, a hairline rule, and a tabular count head every list section."
          >
            <SectionLabelDemo />
          </Row>
          <Row
            title="Navigation"
            note="Flush on the canvas. Active is a neutral foreground wash with the label re-inked — no fill and no tick; the ink weight is the whole signal."
          >
            <NavDemo />
          </Row>
          <Row
            title="Toolbar"
            note="A segmented version switch and quiet icon actions, with one primary."
          >
            <ToolbarDemo />
          </Row>
          <Row
            title="Empty state"
            note="Boxless — a muted icon, a Geist headline, one plain line, and one quiet action, straight on the canvas."
          >
            <EmptyStateDemo />
          </Row>
        </Group>

        <Group title="Overlays & feedback">
          <Row
            title="Overlays"
            note="The floating-surface family — tooltip, popover, menu, dialog, and sheet — each a surface step with a ring edge. Click to open."
          >
            <OverlaysDemo />
          </Row>
          <Row
            title="Command palette"
            note="The ⌘K surface: fuzzy search over artifacts, people, and actions."
          >
            <CommandDemo />
          </Row>
          <Row
            title="Confirm dialog"
            note="The one destructive-confirm surface — the dialog carries the gravity, not a loud red fill."
          >
            <ConfirmDemo />
          </Row>
          <Row
            title="Status panel"
            note="A tinted callout: a tone wash plus an inset ring. Success, warning, and danger are the statuses; brand (the ink accent) is for brand moments, not a status."
          >
            <StatusPanelDemo />
          </Row>
          <Row
            title="Feedback"
            note="Toasts fire from the bottom; skeletons hold layout while data loads."
          >
            <FeedbackDemo />
          </Row>
          <Row
            title="Loading states"
            note="Spinner (sm · default · lg, plus the current-ink tone on a busy button) for actions and unknowable waits; the Skeleton breath — shape-matched to the content — for known layouts. Fast loads flash nothing; shaped skeletons only for slower ones."
          >
            <LoadingDemo />
          </Row>
        </Group>
      </div>
    </div>
  )
}

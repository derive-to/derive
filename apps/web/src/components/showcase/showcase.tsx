import { type ReactNode, useState } from "react"
import { ThemeSwitch } from "@/components/chrome/theme-switch"
import { Icon, type IconName } from "@/components/icons"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { EmptyState } from "@/components/shared/empty-state"
import { FormField } from "@/components/shared/form-field"
import { SearchField } from "@/components/shared/search-field"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { SectionHeading, SectionTitle } from "@/components/shared/section-title"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
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
import {
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "@/components/ui/sonner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { getInitials } from "@/lib/initials"
import { REVEAL } from "@/lib/interaction"
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
          Publish, review, and own your AI artifacts.
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

/** Separator — the vertical rule between control groups inside a bar. */
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
        <Button variant="success">Confirm</Button>
        <Button variant="warning">Flag</Button>
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
      <Badge variant="default">New</Badge>
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
      <RadioGroup value={reach} onValueChange={setReach} className="gap-1.5">
        <span className="mb-0.5 text-sm font-medium text-foreground">Who can reach it</span>
        {(
          [
            ["team", "Your team"],
            ["public", "Anyone with the link"],
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
    <div className="group relative flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-sm)] transition-shadow duration-state hover:shadow-[var(--shadow)]">
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
            The intro reads well. Can we tighten the second paragraph before this ships?
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

/** The header grammar, all levels on one canvas: a page section is a heading; a
 *  sub-group or a day is a bare eyebrow; inside a panel the title is one step
 *  down and the panel's edges are the only lines; a line on its own marks a
 *  position. No label ever carries a rule. */
function SectionLabelDemo() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <SectionHeading
          count={12}
          action={<span className="font-mono text-2xs text-muted-foreground">View all</span>}
        >
          Needs you
        </SectionHeading>
        <div className="flex flex-col">
          <Eyebrow as="h3" className="pt-1 pb-1">
            Reviews waiting on you
          </Eyebrow>
          <p className="py-1 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Claude Code</span> asked for review of v4
          </p>
          <p className="py-1 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Codex</span> asked for review of v2
          </p>
        </div>
        <div className="flex flex-col">
          <Eyebrow as="h3" className="pt-3 pb-1">
            Yesterday
          </Eyebrow>
          <p className="py-1 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Mert</span> published v3 of Q3 Growth
            Narrative
          </p>
        </div>
        <div className="flex items-center gap-2 py-2">
          <Separator className="flex-1 bg-primary" />
          <Eyebrow className="text-primary">New</Eyebrow>
          <Separator className="flex-1 bg-primary" />
        </div>
      </div>
      <div className="flex flex-col gap-2 rounded-xl border bg-card p-4">
        <SectionTitle
          count={3}
          action={<span className="font-mono text-2xs text-muted-foreground">Manage</span>}
        >
          People with access
        </SectionTitle>
        <p className="text-sm text-muted-foreground">
          Inside a dialog, a card or a rail the title steps down one size, and the container's edges
          are the only lines.
        </p>
      </div>
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
// The REAL rail rows, not a restatement of them. This demo used to hand-roll its own
// grammar (a `bg-foreground/5` active wash) which the shipping sidebar never used, so
// the reference page and the app disagreed about what navigation looks like — and the
// page you check your work against is the last place that should be guessing.
function NavDemo() {
  return (
    <SidebarProvider className="min-h-0 w-auto">
      <SidebarMenu className="w-56">
        {NAV.map((r, i) => (
          <SidebarMenuItem key={r.label}>
            <SidebarMenuButton isActive={i === 0}>
              <Icon name={r.icon} size={16} />
              <span>{r.label}</span>
            </SidebarMenuButton>
            {r.count ? <SidebarMenuBadge>{r.count}</SidebarMenuBadge> : null}
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarProvider>
  )
}

// Hover each row. The point of the row is the one rule that is easy to get wrong:
// the CURRENT page keeps its raised chip under the pointer. It did not for a while —
// `hover:bg-*` outranks `data-active:bg-*` on specificity, so the selected row
// repainted itself as an idle row exactly when you pointed at it. See
// lib/interaction.ts; check-interaction.mjs fails the build if it comes back.
function RowStatesDemo() {
  return (
    <SidebarProvider className="min-h-0 w-auto">
      <div className="flex flex-wrap gap-8">
        <div className="flex flex-col gap-1.5">
          <Eyebrow>Current page</Eyebrow>
          <SidebarMenu className="w-48">
            <SidebarMenuItem>
              <SidebarMenuButton isActive>
                <Icon name="all" size={16} />
                <span>Artifacts</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <p className="max-w-48 text-xs text-muted-foreground">
            Raised chip with a card surface and hairline ring. It stays visible on hover.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Eyebrow>Idle</Eyebrow>
          <SidebarMenu className="w-48">
            <SidebarMenuItem>
              <SidebarMenuButton>
                <Icon name="context" size={16} />
                <span>Contexts</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <p className="max-w-48 text-xs text-muted-foreground">
            Transparent at rest, neutral wash on hover.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Eyebrow>Reveal on hover</Eyebrow>
          <div className="group flex w-48 items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-secondary">
            <Icon name="collection" size={16} className="text-muted-foreground" />
            <span className="flex-1 truncate">Product marketing</span>
            <button
              type="button"
              aria-label="Star"
              data-testid="showcase-reveal"
              className={cn("grid size-6 shrink-0 place-items-center rounded-md", REVEAL)}
            >
              <Icon name="star" size={14} className="text-muted-foreground" />
            </button>
          </div>
          <p className="max-w-48 text-xs text-muted-foreground">
            One spelling (REVEAL): hover, focus anywhere in the row, always on touch.
          </p>
        </div>
      </div>
    </SidebarProvider>
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

/** The share dialog's general access — three audiences (glyph + label +
 *  consequence); a password is a lock on Public, not a fourth row. Static data;
 *  the live control is ShareButton's Select in pages/artifact/share-dialog. */
function GeneralAccessDemo() {
  const steps: { icon: IconName; label: string; blurb: string; current?: boolean }[] = [
    {
      icon: "lock",
      label: "Invited",
      blurb: "Only people you add. Even the workspace gets nothing.",
    },
    {
      icon: "workspace",
      label: "Workspace",
      blurb: "Everyone in the workspace opens it at their role.",
      current: true,
    },
    {
      icon: "globe",
      label: "Anyone",
      blurb: "The link works for anyone. Optionally behind a password.",
    },
  ]
  return (
    <div className="max-w-md rounded-xl border border-border bg-card p-1.5">
      {steps.map((s) => (
        <div
          key={s.label}
          className={cn(
            "flex items-start gap-2.5 rounded-lg px-2.5 py-2",
            s.current && "bg-accent",
          )}
        >
          <Icon name={s.icon} className="mt-0.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              {s.label}
              {s.current && (
                <Badge variant="secondary" className="text-2xs">
                  Default
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{s.blurb}</p>
          </div>
        </div>
      ))}
    </div>
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
              Derive design system
            </h1>
            <p className="mt-4 text-base text-pretty text-muted-foreground">
              A practical reference for Derive components, states, and content patterns. Switch
              themes to check each example in light and dark mode.
            </p>
          </div>
          <ThemeSwitch className="w-40 shrink-0" />
        </header>

        <Group title="Foundations">
          <Row
            title="Type"
            note="Use Geist Sans for interface text and Geist Mono for counts, keys, and code."
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
            note="Use monochrome Lucide icons at size 4. Icons inherit the color of nearby text."
          >
            <IconGridDemo />
          </Row>
          <Row
            title="Separator"
            note="A hairline for structure or position: a bar's edge, a table row, the unread marker, or a vertical rule between control groups inside a bar. Never between two sections, and never on a label."
          >
            <SeparatorDemo />
          </Row>
        </Group>

        <Group title="Controls">
          <Row
            title="Buttons"
            note="Use one filled primary action per view. Keep other actions quiet, including destructive actions until confirmation."
          >
            <ButtonsDemo />
          </Row>
          <Row
            title="Icon buttons"
            note="Use ghost icon buttons in toolbars and outlined icon buttons on card corners."
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
            note="Toggle groups use one tab stop. Arrow keys move the selection, and the selected item has a neutral wash."
          >
            <ViewToggleDemo />
          </Row>
          <Row
            title="Badges and status"
            note="Badges are neutral by default. Use color only when it communicates a real state."
          >
            <BadgesDemo />
          </Row>
          <Row title="Form" note="Labels, fields, helper text, and a single clear primary.">
            <FormDemo />
          </Row>
          <Row
            title="Form controls"
            note="Selects, checkboxes, switches, and radio groups use the shared Radix controls."
          >
            <FormControlsDemo />
          </Row>
          <Row
            title="Search"
            note="Search fields share the same icon, focused placeholder, keyboard hint, clear action, and loading state."
          >
            <SearchFieldDemo />
          </Row>
        </Group>

        <Group title="Surfaces and content">
          <Row
            title="Artifact card"
            note="Artifact titles lead each card. Icons stay muted unless a star marks the artifact as a favorite."
          >
            <ArtifactCardsDemo />
          </Row>
          <Row title="Comment" note="Comments show the author, message, and quiet actions.">
            <CommentDemo />
          </Row>
          <Row
            title="Avatar"
            note="Initials fallback across sizes, the workspace soft ink tint (never a solid ink block), and a stacked group."
          >
            <AvatarDemo />
          </Row>
          <Row
            title="Headings"
            note="A page section is a heading, a sub-group or a day is a bare eyebrow, a panel's title steps down one size. No label carries a rule; a line on its own marks a position."
          >
            <SectionLabelDemo />
          </Row>
          <Row
            title="Navigation"
            note="The active rail item uses a card surface, a hairline ring, and stronger text color. Font weight does not change."
          >
            <NavDemo />
          </Row>
          <Row
            title="Row states"
            note="Rows have resting, current, and hover states. The current state remains visible on hover."
          >
            <RowStatesDemo />
          </Row>
          <Row
            title="Toolbar"
            note="A segmented version switch and quiet icon actions, with one primary."
          >
            <ToolbarDemo />
          </Row>
          <Row
            title="Empty state"
            note="Empty states sit directly on the canvas with a muted icon, a short heading, one sentence, and one quiet action."
          >
            <EmptyStateDemo />
          </Row>
        </Group>

        <Group title="Overlays and feedback">
          <Row
            title="Overlays"
            note="Tooltips, popovers, menus, dialogs, and sheets use the same floating surface and ring edge."
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
            note="Confirm destructive actions in a dialog. The dialog carries the warning instead of a loud trigger button."
          >
            <ConfirmDemo />
          </Row>
          <Row
            title="General access"
            note="The share dialog's access ladder, most closed to most open. Each step is a glyph + label + one-line consequence; the Share trigger echoes the glyph (globe = the URL alone reads, lock = invite-only)."
          >
            <GeneralAccessDemo />
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
            note="Use spinners for actions and waits with no known shape. Use matching skeletons for slower loads when the layout is known. Fast loads show neither."
          >
            <LoadingDemo />
          </Row>
        </Group>
      </div>
    </div>
  )
}

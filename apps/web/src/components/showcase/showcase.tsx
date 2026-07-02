import { type ReactNode, useState } from "react"
import { toast } from "sonner"
import { Icon, type IconName } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { FormField } from "@/components/shared/form-field"
import { SectionEyebrow } from "@/components/shared/section-eyebrow"
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
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { getInitials } from "@/lib/initials"
import { cn } from "@/lib/utils"

// The design-system reference: the visual language shown through the real
// components it produces, so it can be reviewed and evolved before it touches
// product surfaces. Restraint is the point — amber is the one warm note,
// hierarchy comes from type registers, weight, and the charcoal surface ramp.
// Lives outside pages/ + components/shared/ (it's a design canvas, not a product
// surface), and is fully token-pure so it doubles as proof the token system is
// complete. At /showcase.

/** A reference row: a fixed label column on the left, live examples on the right. */
function Row({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="grid gap-x-10 gap-y-5 border-t border-border-soft py-11 md:grid-cols-[184px_1fr]">
      <div className="md:pt-0.5">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {note ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{note}</p> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

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
      <div className="relative aspect-[16/10] overflow-hidden bg-gradient-to-br from-accent to-secondary">
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
            size={14}
            weight={starred ? "fill" : "regular"}
            className={starred ? "text-primary" : "text-muted-foreground"}
          />
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-2 border-t border-border-soft p-3.5">
        {/* Artifact titles are the work, not the tool — the serif voice register. */}
        <span className="truncate font-serif text-lg font-medium tracking-tight text-foreground">
          {title}
        </span>
        <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <span>updated 2d</span>
          <span className="ml-auto inline-flex items-center gap-2 tabular-nums">
            <span className="inline-flex items-center gap-1">
              <Icon name="comments" size={13} className="text-muted-foreground" /> {comments}
            </span>
            <span className="inline-flex items-center gap-1">
              <Icon name="views" size={13} className="text-muted-foreground" /> {views}
            </span>
          </span>
        </span>
        <div className="flex items-center gap-2">
          <Avatar className="size-5">
            <AvatarFallback>{getInitials(handle)}</AvatarFallback>
          </Avatar>
          <span className="font-mono text-xs text-muted-foreground">@{handle}</span>
        </div>
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
          <span className="block text-xs text-muted-foreground">On new comments and versions.</span>
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
        <Icon name="all" size={14} />
        List
      </ToggleGroupItem>
      <ToggleGroupItem value="folders" aria-label="Folders">
        <Icon name="collection" size={14} />
        Folders
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

const NAV: { icon: IconName; label: string; count?: number }[] = [
  { icon: "all", label: "All", count: 24 },
  { icon: "favorites", label: "Favorites", count: 6 },
  { icon: "following", label: "Following" },
  { icon: "collections", label: "Collections", count: 4 },
]

/** A mini nav rail — the real row grammar: flush on the canvas, rest muted, hover
 *  a neutral wash, active a foreground/5 wash plus the 3px amber left bar. Color
 *  flips are instant; no font-weight change between states. */
function NavDemo() {
  return (
    <div className="flex w-56 flex-col gap-px">
      {NAV.map((r, i) => {
        const active = i === 0
        return (
          <div
            key={r.label}
            className={cn(
              "relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium",
              active
                ? "bg-foreground/5 text-foreground before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-[3px] before:rounded-full before:bg-primary before:content-['']"
                : "text-muted-foreground hover:bg-hover hover:text-foreground",
            )}
          >
            <Icon name={r.icon} size={18} />
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

/** A comment row — avatar, identity, body, and the quiet action affordances. */
function CommentDemo() {
  return (
    <div className="flex gap-3 rounded-lg border border-border bg-card p-4">
      <Avatar className="size-7">
        <AvatarFallback>AL</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-foreground">Ana Lima</span>
          <span className="font-mono text-2xs text-muted-foreground">@ana · 2h</span>
        </div>
        <p className="mt-1 text-sm leading-relaxed text-foreground/90">
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
  )
}

/** Avatar — initials fallback across sizes, the workspace soft-brand tint, and a
 *  stacked group. Never a solid amber block. */
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
          <AvatarFallback className="bg-primary/15 text-primary">DR</AvatarFallback>
        </Avatar>
        <span className="font-mono text-2xs text-muted-foreground">workspace · soft brand</span>
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

/** Tabs — the filled neutral wash for panel switches, and the line variant whose
 *  amber underline is the ONE amber selected state (an underlined tab is nav-like). */
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
    </div>
  )
}

/** Overlays — tooltip, popover, dropdown menu, dialog, and sheet, each on a
 *  trigger, so the whole floating-surface family is reviewable in one place.
 *  Tooltips are surface-style now (popover step + inset ring), not inverted. */
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
            <p className="mt-1 text-xs text-muted-foreground">
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
 *  The rebuilt frame is the raised card surface with a ring edge; no extra chrome. */
function CommandDemo() {
  return (
    <Command className="max-w-md ring-1 ring-foreground/10">
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

/** Feedback — toasts (sonner) and skeleton loaders. */
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

// The chrome register (Inter) across the scale — tool-surface headings stay Inter.
const TYPE_SPECIMEN = [
  {
    cls: "text-3xl font-semibold tracking-tight",
    label: "Chrome display · 3xl / semibold",
    sample: "Design system",
  },
  {
    cls: "text-xl font-semibold tracking-tight",
    label: "Chrome title · xl / semibold",
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

// The charcoal surface steps — canvas, raised, floating, well.
const SURFACES = [
  { cls: "bg-background", label: "background" },
  { cls: "bg-card", label: "card" },
  { cls: "bg-popover", label: "popover" },
  { cls: "bg-secondary", label: "secondary" },
]

// The four hues, each with one job. Amber is brand; safety-orange is the warning
// (a different hue family, so alerts never read as brand notes).
const ACCENTS = [
  { cls: "bg-primary", label: "primary · amber" },
  { cls: "bg-success", label: "success" },
  { cls: "bg-warning", label: "warning · safety orange" },
  { cls: "bg-destructive", label: "destructive" },
]

// The working middle of the honey-amber ramp (--color-brand-*): 500 is the dark
// primary, 700 the light-mode bronze primary, 600 the light focus ring.
const BRAND_RAMP = ["bg-brand-300", "bg-brand-400", "bg-brand-500", "bg-brand-600", "bg-brand-700"]

const CATEGORICAL: IconName[] = ["share", "comments", "tag", "collections", "insights", "review"]

export function Showcase() {
  return (
    <div className="min-h-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto w-full max-w-4xl px-6 py-14">
        <header className="flex flex-wrap items-end justify-between gap-4 pb-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Design system</h1>
            <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
              The Derive identity on shadcn — charcoal surfaces, three type registers, and honey
              amber as the one warm note. Toggle the theme to review both.
            </p>
          </div>
          <ThemeSwitch className="w-36" />
        </header>

        <Row
          title="Type"
          note="Three registers: Inter is the working chrome, Source Serif carries moments of voice (greetings, artifact titles, empty states), Geist Mono is the machine layer (counts, versions, kbd, eyebrows)."
        >
          <div className="space-y-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <span className="font-serif text-2xl font-medium tracking-tight text-balance">
                The permanent home for your AI artifacts.
              </span>
              <span className="font-mono text-2xs text-muted-foreground">Voice · serif / 2xl</span>
            </div>
            {TYPE_SPECIMEN.map((t) => (
              <div
                key={t.label}
                className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1"
              >
                <span className={t.cls}>{t.sample}</span>
                <span className="font-mono text-2xs text-muted-foreground">{t.label}</span>
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
              <span className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-2xs uppercase tracking-wide text-muted-foreground">
                  Markdown
                </span>
                <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                  v3 · updated 2d · 128 views
                </span>
                <Kbd>⌘K</Kbd>
              </span>
              <span className="font-mono text-2xs text-muted-foreground">Machine · mono / 2xs</span>
            </div>
          </div>
        </Row>

        <Row
          title="Buttons"
          note="One filled primary per view — everything else stays quiet. Destructive is a soft red fill; the loud moment is the confirm dialog, never the button."
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2.5">
              <Button variant="default">Publish</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="destructive">Delete</Button>
              <Button variant="link">Link</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <Button variant="secondary" size="sm">
                <Icon name="plus" size={14} /> Small
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
            </div>
          </div>
        </Row>

        <Row
          title="Icon buttons"
          note="Stock Button at size='icon' — ghost for toolbars, outline for a card-corner chip."
        >
          <div className="flex flex-wrap items-center gap-6">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon-xs" aria-label="Share">
                <Icon name="share" size={14} className="text-muted-foreground" />
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
                <Icon name="star" size={14} className="text-muted-foreground" />
              </Button>
              <Button variant="outline" size="icon-sm" aria-label="Pin">
                <Icon name="pin" size={16} className="text-muted-foreground" />
              </Button>
              <span className="font-mono text-2xs text-muted-foreground">chip</span>
            </div>
          </div>
        </Row>

        <Row
          title="Artifact card"
          note="The most-seen surface. Titles are the work, so they speak serif; icons sit muted — only a starred favorite earns the amber."
        >
          <div className="grid gap-3 sm:grid-cols-2">
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
        </Row>

        <Row
          title="Navigation"
          note="Flush on the canvas. Active is a neutral foreground wash plus the 3px amber left bar — selection stays a white wash; the bar alone carries the brand."
        >
          <NavDemo />
        </Row>

        <Row
          title="Section label"
          note="Mono smallcaps, a hairline rule, and a tabular count head every list section — the same quiet voice as the rail."
        >
          <div className="space-y-6">
            <SectionEyebrow count={12} icon={<Icon name="comments" size={13} />}>
              Needs your feedback
            </SectionEyebrow>
            <SectionEyebrow
              count={128}
              action={
                <span className="font-mono text-2xs text-muted-foreground">Browse all →</span>
              }
            >
              All artifacts
            </SectionEyebrow>
          </div>
        </Row>

        <Row
          title="Status panel"
          note="A tinted callout: bg-tone/10 plus an inset ring. Success, warning, and danger are the statuses; brand is for brand moments (sync, upgrade nudges) — amber is not a status."
        >
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
          </div>
        </Row>

        <Row
          title="Empty state"
          note="Boxless — an icon with a faint brand tint, a serif headline, one plain line, and ONE quiet action, straight on the canvas. Distinct from a status panel, so nothing-here never reads as an error."
        >
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
        </Row>

        <Row
          title="Toolbar"
          note="Segmented version switch and quiet icon actions, with one primary."
        >
          <ToolbarDemo />
        </Row>

        <Row title="Comment" note="The review loop — identity, body, and low-key actions.">
          <div className="max-w-lg">
            <CommentDemo />
          </div>
        </Row>

        <Row
          title="Avatar"
          note="Initials fallback across sizes, the workspace soft-brand tint (never a solid amber block), and a stacked group."
        >
          <AvatarDemo />
        </Row>

        <Row
          title="Tabs"
          note="Filled segments stay a neutral wash; the line variant's amber underline is the one amber selected state — an underlined tab is nav-like."
        >
          <TabsDemo />
        </Row>

        <Row
          title="Overlays"
          note="The floating-surface family — surface tooltip, popover, dropdown menu, dialog, and sheet — each a surface step with a ring edge. Click to open."
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
          title="Feedback"
          note="Toasts (sonner) fire from the bottom; skeletons hold layout while data loads."
        >
          <FeedbackDemo />
        </Row>

        <Row
          title="Separator"
          note="A hairline rule (horizontal or vertical) to divide related groups."
        >
          <div className="flex h-5 items-center gap-3 text-sm text-muted-foreground">
            <span>Edit</span>
            <Separator orientation="vertical" />
            <span>Share</span>
            <Separator orientation="vertical" />
            <span>Delete</span>
          </div>
        </Row>

        <Row title="Form" note="Labels, fields, helper text, and a clear primary.">
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
        </Row>

        <Row title="Form controls" note="Stock Radix — select, checkbox, switch, and radio group.">
          <FormControlsDemo />
        </Row>

        <Row
          title="Badges & status"
          note="Neutral by default — tonal variants only for genuine state: brand for brand moments, success / warning / destructive for status."
        >
          <div className="flex flex-wrap items-center gap-2.5">
            <Badge variant="default">Draft</Badge>
            <Badge variant="brand">Shared</Badge>
            <Badge variant="success">Published</Badge>
            <Badge variant="warning">Sync stale</Badge>
            <Badge variant="destructive">Failed</Badge>
            <Badge variant="outline">v3</Badge>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-success" /> Synced
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
              <span className="size-1.5 rounded-full bg-destructive" /> Failed
            </span>
          </div>
        </Row>

        <Row
          title="View toggle"
          note="Stock ToggleGroup (type='single') — one tab stop, arrow keys move selection; pressed is a neutral wash, never amber. For List/Folders-style view switches."
        >
          <div className="flex flex-wrap items-center gap-6">
            <SegmentedDemo />
            <span className="inline-flex items-center gap-1.5 font-mono text-2xs text-muted-foreground">
              Search <Kbd>⌘K</Kbd> · Toggle rail <Kbd>⌘B</Kbd>
            </span>
          </div>
        </Row>

        <Row
          title="Color"
          note="Charcoal surfaces with one warm note: amber means 'this matters' — primary actions, active nav, focus, links, unread. Safety-orange warns, red is danger, green confirms. Feature icons stay monochrome."
        >
          <div className="space-y-5">
            <div>
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
            <div className="flex flex-wrap items-center gap-5">
              {ACCENTS.map((a) => (
                <span key={a.label} className="inline-flex items-center gap-2">
                  <span className={cn("size-5 rounded-md border border-border-soft", a.cls)} />
                  <span className="font-mono text-2xs text-muted-foreground">{a.label}</span>
                </span>
              ))}
            </div>
            <div>
              <div className="flex w-fit overflow-hidden rounded-md border border-border-soft">
                {BRAND_RAMP.map((cls) => (
                  <div key={cls} className={cn("h-8 w-12", cls)} />
                ))}
              </div>
              <div className="mt-1.5 flex w-fit">
                {BRAND_RAMP.map((cls) => (
                  <span key={cls} className="w-12 font-mono text-2xs text-muted-foreground">
                    {cls.replace("bg-brand-", "")}
                  </span>
                ))}
              </div>
              <p className="mt-1 font-mono text-2xs text-muted-foreground">
                brand-300 → brand-700 · dark primary is 500, light primary is 700
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              {CATEGORICAL.map((n) => (
                <div key={n} className="flex flex-col items-center gap-1">
                  <Icon name={n} size={16} className="text-muted-foreground" />
                  <span className="font-mono text-2xs text-muted-foreground">{n}</span>
                </div>
              ))}
            </div>
          </div>
        </Row>
      </div>
    </div>
  )
}

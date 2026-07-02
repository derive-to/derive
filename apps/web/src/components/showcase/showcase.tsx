import { type ReactNode, useState } from "react"
import { toast } from "sonner"
import { Icon, type IconName } from "@/components/icons"
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
// product surfaces. Restraint is the point — color is reserved, hierarchy comes
// from type, weight, and a neutral surface ramp. Lives outside pages/ +
// components/shared/ (it's a design canvas, not a product surface), and is fully
// token-pure so it doubles as proof the token system is complete. At /showcase.

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
            className={starred ? "text-foreground" : "text-muted-foreground"}
          />
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-2 border-t border-border-soft p-3.5">
        <span className="truncate text-lg font-medium tracking-tight text-foreground">{title}</span>
        <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <span>updated 2d</span>
          <span className="ml-auto inline-flex items-center gap-2">
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

/** A mini nav rail — showing the refined, restrained active state (subtle fill +
 *  a hairline accent), the Linear-grade replacement for the old full-ink fill. */
function NavDemo() {
  return (
    <div className="w-56 rounded-lg border border-border bg-card p-1.5">
      {NAV.map((r, i) => {
        const active = i === 0
        return (
          <div
            key={r.label}
            className={cn(
              "relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-foreground/10 text-foreground before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-[3px] before:rounded-full before:bg-primary before:content-['']"
                : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
            )}
          >
            <Icon
              name={r.icon}
              size={17}
              className={active ? undefined : "text-muted-foreground"}
            />
            <span>{r.label}</span>
            {r.count ? (
              <span className="ml-auto font-mono text-2xs text-muted-foreground">{r.count}</span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** The artifact toolbar — a segmented version switch plus actions. */
function ToolbarDemo() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2">
      <div className="flex items-center gap-0.5 rounded-md bg-secondary p-0.5">
        {["v3", "v2", "v1"].map((v, i) => (
          <button
            type="button"
            key={v}
            className={cn(
              "rounded px-2 py-1 font-mono text-2xs transition-colors",
              i === 0
                ? "bg-card text-foreground shadow-[var(--shadow)]"
                : "text-muted-foreground hover:text-foreground",
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
          <button type="button" className="transition-colors hover:text-foreground">
            Reply
          </button>
          <button type="button" className="transition-colors hover:text-foreground">
            Resolve
          </button>
        </div>
      </div>
    </div>
  )
}

/** Avatar — image, initials fallback across sizes, and a stacked group. */
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

/** Tabs — the Preview / Source / History switch used on the artifact page. */
function TabsDemo() {
  return (
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
  )
}

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

/** Command palette — the ⌘K surface, shown inline (the app mounts it in a dialog). */
function CommandDemo() {
  return (
    <Command className="max-w-md rounded-lg border border-border shadow-[var(--shadow)]">
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

const TYPE_SPECIMEN = [
  {
    cls: "text-3xl font-semibold tracking-tight",
    label: "Display · 3xl / semibold",
    sample: "Derive",
  },
  {
    cls: "text-xl font-semibold tracking-tight",
    label: "Title · xl / semibold",
    sample: "Quarterly review",
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
  {
    cls: "font-mono text-2xs uppercase tracking-[0.14em] text-muted-foreground",
    label: "Label · 2xs / mono",
    sample: "Markdown",
  },
]

const SURFACES = [
  { cls: "bg-background", label: "background" },
  { cls: "bg-card", label: "card" },
  { cls: "bg-secondary", label: "secondary" },
  { cls: "bg-hover", label: "hover" },
]

const CATEGORICAL: IconName[] = ["share", "comments", "tag", "collections", "insights", "review"]

export function Showcase() {
  return (
    <div className="min-h-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto w-full max-w-4xl px-6 py-14">
        <header className="flex flex-wrap items-end justify-between gap-4 pb-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Design system</h1>
            <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
              Stock shadcn components, kept monochrome — hierarchy comes from ink, weight, and a
              neutral surface ramp. Toggle the theme to review both.
            </p>
          </div>
          <ThemeSwitch className="w-36" />
        </header>

        <Row
          title="Type"
          note="Inter, tracking pulled in a hair. Hierarchy from size, weight, and ink — not color."
        >
          <div className="space-y-5">
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
        </Row>

        <Row
          title="Buttons"
          note="Stock variants — the filled default carries emphasis; everything else stays quiet. Destructive red is the one hue."
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2.5">
              <Button variant="default">Default</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="destructive">Destructive</Button>
              <Button
                variant="ghost"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                Quiet delete
              </Button>
              <Button variant="link">Link</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <Button size="sm">
                <Icon name="plus" size={14} /> Small
              </Button>
              <Button size="default">Default</Button>
              <Button size="lg">Large</Button>
              <Button disabled>Disabled</Button>
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
                <Icon name="share" size={15} className="text-muted-foreground" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Comment">
                <Icon name="comments" size={16} className="text-muted-foreground" />
              </Button>
              <Button variant="ghost" size="icon" aria-label="More">
                <Icon name="more" size={18} className="text-muted-foreground" />
              </Button>
              <span className="font-mono text-2xs text-muted-foreground">ghost</span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon-xs" aria-label="Star">
                <Icon name="star" size={14} className="text-muted-foreground" />
              </Button>
              <Button variant="outline" size="icon-sm" aria-label="Pin">
                <Icon name="pin" size={15} className="text-muted-foreground" />
              </Button>
              <span className="font-mono text-2xs text-muted-foreground">chip</span>
            </div>
          </div>
        </Row>

        <Row
          title="Artifact card"
          note="The most-seen surface. Icons sit muted; only a starred favorite earns color."
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
          note="Active is a subtle fill plus a mono left-edge bar, not a heavy full-ink block."
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
          note="A tinted callout for a transient error or degraded state — distinct from an empty state, so a failed load never reads as an empty library."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <StatusPanel
              tone="danger"
              title="Couldn't load the library"
              description="This is usually temporary."
            />
            <StatusPanel
              tone="neutral"
              title="Sync in progress"
              description="Mirroring the latest from GitHub."
            />
          </div>
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

        <Row title="Avatar" note="Initials fallback across sizes, and a stacked group.">
          <AvatarDemo />
        </Row>

        <Row title="Tabs" note="Underline tabs — the Preview / Source / History switch.">
          <TabsDemo />
        </Row>

        <Row
          title="Overlays"
          note="The floating-surface family — tooltip, popover, dropdown menu, dialog, and sheet — each on a trigger. Click to open."
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
          note="Mono by default; reserved for genuine state, never decoration."
        >
          <div className="flex flex-wrap items-center gap-2.5">
            <Badge variant="default">Draft</Badge>
            <Badge variant="outline">Link</Badge>
            <Badge variant="default">Published</Badge>
            <Badge variant="outline" className="border-transparent bg-muted text-muted-foreground">
              Approved
            </Badge>
            <Badge variant="secondary">v3</Badge>
            <Badge variant="destructive">2</Badge>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-muted-foreground" /> Synced
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
              <span className="size-1.5 rounded-full bg-destructive" /> Failed
            </span>
          </div>
        </Row>

        <Row
          title="View toggle"
          note="Stock ToggleGroup (type='single') — one tab stop, arrow keys move selection. For List/Folders-style view switches."
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
          note="Pure ink on a neutral surface ramp. Destructive red is the only hue (shadcn's default); the focus ring and active-nav bar use the primary ink. Feature icons are monochrome."
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
              {[
                { cls: "bg-primary", label: "primary · ink" },
                { cls: "bg-muted-foreground", label: "muted · ink" },
                { cls: "bg-destructive", label: "destructive" },
              ].map((a) => (
                <span key={a.label} className="inline-flex items-center gap-2">
                  <span className={cn("size-5 rounded-md border border-border-soft", a.cls)} />
                  <span className="font-mono text-2xs text-muted-foreground">{a.label}</span>
                </span>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-4">
              {CATEGORICAL.map((n) => (
                <div key={n} className="flex flex-col items-center gap-1">
                  <Icon name={n} size={18} className="text-muted-foreground" />
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

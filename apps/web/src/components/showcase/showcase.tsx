import type { ReactNode } from "react"
import { Icon, type IconName } from "@/components/icons"
import { FormField } from "@/components/shared/form-field"
import { ThemeSwitch } from "@/components/theme-switch"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Input, Textarea } from "@/components/ui/input"
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

/** A faithful copy of the library artifact card — the app's most-seen surface. */
function ArtifactCardDemo({
  kind,
  title,
  handle,
  versions,
  comments,
  views,
  starred,
}: {
  kind: { icon: IconName; label: string }
  title: string
  handle: string
  versions: number
  comments: number
  views: number
  starred?: boolean
}) {
  return (
    <div className="group relative flex flex-col gap-2 rounded-lg border border-border bg-card p-3.5 transition-all motion-safe:hover:-translate-y-0.5 hover:border-primary hover:shadow-[var(--shadow)]">
      <div className="absolute right-2.5 top-2.5 grid size-7 place-items-center rounded-md border border-border bg-card">
        <Icon
          name="star"
          size={14}
          weight={starred ? "fill" : "regular"}
          className={starred ? "text-gold" : "text-muted-foreground"}
        />
      </div>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon name={kind.icon} size={13} className="text-muted-foreground" />
        <span className="font-mono text-2xs uppercase tracking-[0.1em]">{kind.label}</span>
      </div>
      <h3 className="pr-8 text-sm font-semibold leading-snug text-foreground">{title}</h3>
      <div className="flex items-center gap-3 font-mono text-2xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Icon name="history" size={12} className="text-muted-foreground" /> {versions}
        </span>
        <span className="inline-flex items-center gap-1">
          <Icon name="comments" size={12} className="text-muted-foreground" /> {comments}
        </span>
        <span className="inline-flex items-center gap-1">
          <Icon name="views" size={12} className="text-muted-foreground" /> {views}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 border-t border-border-soft pt-2.5">
        <Avatar className="size-5">
          <AvatarFallback>{getInitials(handle)}</AvatarFallback>
        </Avatar>
        <span className="font-mono text-xs text-muted-foreground">@{handle}</span>
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
              "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-foreground/10 text-foreground"
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
        <Button size="sm" variant="primary">
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
              The visual language, shown through real components. Monochrome by default — color is
              reserved. Toggle the theme to review both.
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
          note="One filled primary carries emphasis; everything else stays quiet."
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2.5">
              <Button variant="primary">Publish</Button>
              <Button variant="default">Default</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="destructive">Delete</Button>
              <Button variant="link">Link</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <Button size="sm" variant="primary">
                <Icon name="plus" size={14} className="text-primary-foreground" /> New
              </Button>
              <Button size="default" variant="default">
                Default
              </Button>
              <Button size="lg" variant="default">
                Large
              </Button>
              <Button variant="default" disabled>
                Disabled
              </Button>
            </div>
          </div>
        </Row>

        <Row
          title="Icon buttons"
          note="One primitive for the icon-chip pattern — ghost for toolbars, chip for card overlays."
        >
          <div className="flex flex-wrap items-center gap-6">
            <div className="flex items-center gap-2">
              <IconButton variant="ghost" size="sm" aria-label="Share">
                <Icon name="share" size={15} className="text-muted-foreground" />
              </IconButton>
              <IconButton variant="ghost" size="md" aria-label="Comment">
                <Icon name="comments" size={16} className="text-muted-foreground" />
              </IconButton>
              <IconButton variant="ghost" size="lg" aria-label="More">
                <Icon name="more" size={18} className="text-muted-foreground" />
              </IconButton>
              <span className="font-mono text-2xs text-muted-foreground">ghost</span>
            </div>
            <div className="flex items-center gap-2">
              <IconButton variant="chip" size="sm" aria-label="Star">
                <Icon name="star" size={14} className="text-muted-foreground" />
              </IconButton>
              <IconButton variant="chip" size="md" aria-label="Pin">
                <Icon name="pin" size={15} className="text-muted-foreground" />
              </IconButton>
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
              kind={{ icon: "reader", label: "Markdown" }}
              title="Q3 board review"
              handle="rob"
              versions={3}
              comments={2}
              views={128}
              starred
            />
            <ArtifactCardDemo
              kind={{ icon: "edit", label: "HTML" }}
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
          note="Active is a subtle fill plus a hairline accent — not a heavy full-ink block."
        >
          <NavDemo />
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
          title="Dialog"
          note="Confirmations: destructive intent named plainly, action on the right."
        >
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-[var(--shadow)]">
            <h3 className="text-base font-semibold text-foreground">Delete artifact?</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              This removes “Q3 board review” and its 3 versions. This can't be undone.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button size="sm" variant="ghost">
                Cancel
              </Button>
              <Button size="sm" variant="destructive">
                Delete
              </Button>
            </div>
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
              <Button size="sm" variant="primary">
                Save
              </Button>
              <Button size="sm" variant="ghost">
                Cancel
              </Button>
            </div>
          </div>
        </Row>

        <Row title="Badges & status" note="Reserved for genuine state, never decoration.">
          <div className="flex flex-wrap items-center gap-2.5">
            <Badge variant="default">Draft</Badge>
            <Badge variant="outline">Link</Badge>
            <Badge variant="primary">Published</Badge>
            <span className="inline-flex items-center gap-1.5 text-xs text-success">
              <span className="size-1.5 rounded-full bg-success" /> Synced
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
              <span className="size-1.5 rounded-full bg-destructive" /> Failed
            </span>
          </div>
        </Row>

        <Row
          title="Color"
          note="A neutral surface ramp does the work. The categorical tints are muted and reserved for feature icons only."
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
            <div className="flex flex-wrap items-center gap-4">
              {CATEGORICAL.map((n) => (
                <div key={n} className="flex flex-col items-center gap-1">
                  <Icon name={n} size={18} />
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

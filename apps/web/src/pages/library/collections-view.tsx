import { Link } from "@tanstack/react-router"
import type { Collection } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { SectionHeading } from "@/components/shared/section-title"
import { Thumb } from "@/components/shared/thumb"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { getInitials } from "@/lib/initials"
import { reveal } from "@/lib/interaction"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"

// The Collections view: the week's work, then the filing cabinet.
//
// Two sections, two orders, two densities — because the page is asked two different
// questions. "What's happening" is the DIGEST: only collections with recent visible
// work, ordered by activity because the section title says so, capped in both
// directions (five shelves, four covers each). "Take me to X" is the INDEX: every
// collection as one tabular line, alphabetical because it is complete, claiming
// nothing about contents it can't show — which is how the old view's "Nothing here
// is visible to you" sentence became structurally impossible rather than reworded.
//
// This replaced two switchable layouts (cover shelves, a grouped list) that were both
// inventories: every collection at full weight in creation order, so the reader had to
// scan the whole page to find the two shelves that were alive.

const WEEK_MS = 7 * 86_400_000
const DIGEST_SHELVES = 5
const DIGEST_COVERS = 4

type Entry = NonNullable<Collection["preview"]>[number]

const byActivity = (a: Collection, b: Collection) =>
  (b.last_activity ?? "").localeCompare(a.last_activity ?? "")

/**
 * Which shelves lead the digest, and in what order. Pure, so the ordering — the thing a
 * reader feels first — is pinned by tests rather than re-derived by reading JSX.
 *
 * YOUR shelves first: the ones you personally touched (published or commented) in the
 * last 30 days, ordered by YOUR latest touch — not by whoever in the workspace got
 * there most recently. A starred shelf rides in the same tier (starring is the
 * reader's opt-in: heavy readers of a shelf they never write in star it), ordered by
 * its workspace activity since you left no timestamp of your own. Then the rest of the
 * workspace's week, by its activity — seeing what teammates moved is still the point
 * of a digest; it just doesn't outrank your desk.
 */
export function digestFor(
  collections: Collection[],
  nowMs: number,
): { week: boolean; cols: Collection[] } {
  const cutoff = new Date(nowMs - WEEK_MS).toISOString()
  const mine = (c: Collection) => !!c.my_last_activity || !!c.starred
  const myKey = (c: Collection) => c.my_last_activity ?? c.last_activity ?? ""
  const yours = collections.filter(mine).sort((a, b) => myKey(b).localeCompare(myKey(a)))
  const theirs = collections
    .filter((c) => !mine(c) && (c.last_activity ?? "") >= cutoff)
    .sort(byActivity)
  const cols = [...yours, ...theirs].slice(0, DIGEST_SHELVES)
  if (cols.length > 0) return { week: true, cols }
  // A quiet month still gets a digest — the three most recently touched shelves, under
  // a label that says exactly that, rather than an empty section implying nothing
  // exists.
  return {
    week: false,
    cols: collections
      .filter((c) => c.last_activity)
      .sort(byActivity)
      .slice(0, 3),
  }
}

export function CollectionsView({
  collections,
  onStar,
  onCreate,
  draft,
  setDraft,
}: {
  collections: Collection[]
  onStar: (id: string, next: boolean) => void
  onCreate: (title: string) => void
  /** Opened from the toolbar's one New button — the page owns the state so there is a
   *  single "+ New" on screen rather than one per surface. */
  draft: string | null
  setDraft: (v: string | null) => void
}) {
  const submit = () => {
    const t = (draft ?? "").trim()
    setDraft(null)
    if (t) onCreate(t)
  }

  // A quiet week still gets a digest — the three most recently touched shelves, under a
  // label that says exactly that, rather than an empty section implying nothing exists.
  const { week, cols: digest } = digestFor(collections, Date.now())
  const indexed = [...collections].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  )

  return (
    <div className="flex flex-col gap-8">
      {/* Create where you can see what you already have. */}
      {draft !== null && (
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            value={draft}
            placeholder="Collection name…"
            aria-label="Collection name"
            data-testid="collections-new-input"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit()
              if (e.key === "Escape") setDraft(null)
            }}
            onBlur={submit}
            className="max-w-64"
          />
          <Button
            variant="outline"
            size="sm"
            data-testid="collections-new-create"
            // Blur fires before click, which would commit and clear the draft before
            // this button ever saw it — keeping focus is what makes it reachable.
            onMouseDown={(e) => e.preventDefault()}
            onClick={submit}
            disabled={!draft.trim()}
          >
            Create
          </Button>
        </div>
      )}

      {collections.length === 0 ? (
        <EmptyState
          icon={<Icon name="collections" strokeWidth={1.75} />}
          title="No collections yet."
          description="A collection groups related artifacts, and sharing one shares everything in it."
        />
      ) : (
        <>
          {digest.length > 0 && (
            <section data-testid="collections-digest">
              <SectionHeading className="mb-3">
                {week ? "Recent work" : "Latest activity"}
              </SectionHeading>
              <div>
                {digest.map((c) => (
                  <DigestEntry key={c.id} col={c} />
                ))}
              </div>
            </section>
          )}

          <section data-testid="collections-index">
            <SectionHeading className="mb-3" action={<Eyebrow>A–Z</Eyebrow>}>
              All collections
            </SectionHeading>
            {/* The header names the columns; the columns hold. */}
            <Eyebrow as="div" className="flex h-6 items-center gap-3 border-b border-border px-1">
              <span className="min-w-0 flex-1">Name</span>
              <span className="w-20 shrink-0 max-md:hidden">Editors</span>
              <span className="w-16 shrink-0 text-right">Artifacts</span>
              <span className="w-28 shrink-0 text-right">Updated</span>
              <span className="w-7 shrink-0" />
            </Eyebrow>
            <div>
              {indexed.map((c) => (
                <IndexRow key={c.id} col={c} onStar={(next) => onStar(c.id, next)} />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

// One shelf in the digest: name and byline above a strip of captioned covers at a size
// you can actually read. The busiest shelf leads by POSITION — never by cell size, which
// re-deals the layout every visit and turns "what makes a cell big" into a tuning tax.
function DigestEntry({ col }: { col: Collection }) {
  // The full strip, always — not just the week's touches. The entry EARNED its digest
  // slot with recent work; once it's here, its four newest covers are more useful than
  // one fresh cover beside implied emptiness.
  const covers = (col.preview ?? []).slice(0, DIGEST_COVERS)
  const hidden = Math.max(0, (col.count ?? 0) - covers.length)

  return (
    <div
      data-testid={`digest-entry-${col.id}`}
      className="border-b border-border-soft py-3.5 last:border-b-0"
    >
      {/* The whole header line is the door, and it looks like one: full-width link, a
          hover wash across the line, and a chevron that answers "this goes somewhere"
          before you commit — the row grammar every list in the app already speaks. */}
      <Link
        to="/"
        search={{ collection: col.id }}
        data-testid={`digest-open-${col.id}`}
        className="group/entry -mx-2 mb-2 flex min-w-0 items-baseline gap-2.5 rounded-md px-2 py-1.5 outline-none transition-colors duration-state hover:bg-secondary/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <span className="min-w-0 truncate font-serif text-base font-semibold tracking-tight text-foreground">
          {col.title}
        </span>
        {col.starred && (
          <Icon name="star" size={12} weight="fill" className="shrink-0 self-center text-primary" />
        )}
        <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
          {col.count} {col.count === 1 ? "artifact" : "artifacts"}
          {col.last_activity && <> · {ago(col.last_activity)}</>}
        </span>
        <span className="min-w-0 flex-1" />
        <EditorDots entries={col.preview ?? []} withNames />
        <Icon
          name="chevron-right"
          size={14}
          aria-hidden
          className="shrink-0 self-center text-muted-foreground/60 transition-[color,transform] duration-state group-hover/entry:translate-x-0.5 group-hover/entry:text-foreground"
        />
      </Link>
      <div className="flex items-center gap-2.5 overflow-hidden">
        {covers.map((p) => (
          <Cover key={p.short_id} p={p} collectionId={col.id} />
        ))}
        {hidden > 0 && (
          <Link
            to="/"
            search={{ collection: col.id }}
            className="shrink-0 rounded-sm font-mono text-2xs text-muted-foreground outline-none transition-colors duration-state hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            +{hidden} more →
          </Link>
        )}
      </div>
    </div>
  )
}

// A captioned cover: the render is the content, the title rides a scrim at its foot.
// Opens the artifact, carrying the collection as list context so the header can page
// between siblings.
function Cover({ p, collectionId }: { p: Entry; collectionId: string }) {
  return (
    <Link
      to="/artifacts/$ref"
      params={{ ref: p.short_id }}
      search={{ collection: collectionId }}
      title={p.title ?? p.short_id}
      className="relative w-36 shrink-0 overflow-hidden rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <Thumb id={p.short_id} v={p.current_version} hasPreview={p.has_preview} />
      <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-scrim/75 px-2 py-0.5 font-mono text-2xs text-scrim-foreground">
        {p.title ?? p.short_id}
      </span>
    </Link>
  )
}

// One line in the index: name, recent editors, count, the full date. Tabular — the
// columns are the affordance — and it never speaks about contents: a shelf with nothing
// you can see is just a dimmer name with a date.
function IndexRow({ col, onStar }: { col: Collection; onStar: (next: boolean) => void }) {
  const dead = (col.count ?? 0) === 0
  return (
    <div className="group relative flex h-10 items-center gap-3 border-b border-border-soft px-1 transition-colors duration-state last:border-b-0 hover:bg-secondary/60">
      <Link
        to="/"
        search={{ collection: col.id }}
        data-testid={`index-open-${col.id}`}
        // Stretched link: the row opens the shelf; the star sits above it.
        className="min-w-0 flex-1 truncate text-sm font-medium tracking-tight outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
      >
        <span className={dead ? "text-muted-foreground" : "text-foreground"}>{col.title}</span>
      </Link>
      <span className="w-20 shrink-0 max-md:hidden">
        <EditorDots entries={col.preview ?? []} />
      </span>
      <span className="w-16 shrink-0 text-right font-mono text-2xs tabular-nums text-muted-foreground">
        {col.count ?? 0}
      </span>
      <span className="w-28 shrink-0 text-right font-mono text-2xs tabular-nums text-muted-foreground">
        {col.last_activity ? fullDate(col.last_activity) : "Not yet"}
      </span>
      <span className="flex w-7 shrink-0 justify-end">
        <button
          type="button"
          data-testid={`collection-star-${col.id}`}
          aria-pressed={!!col.starred}
          aria-label={col.starred ? `Unstar ${col.title}` : `Star ${col.title}`}
          title={col.starred ? "Remove from sidebar" : "Pin to sidebar"}
          onClick={(e) => {
            e.preventDefault()
            onStar(!col.starred)
          }}
          className={cn(
            "relative z-20 grid size-6 place-items-center rounded-md outline-none hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            reveal(!!col.starred),
          )}
        >
          <Icon
            name="star"
            size={13}
            weight={col.starred ? "fill" : "regular"}
            className={col.starred ? "text-primary" : "text-muted-foreground"}
          />
        </button>
      </span>
    </div>
  )
}

// Recent editors, from the strip's bylines: the people who touched the newest artifacts.
// Honest about its basis (recent work, not membership) and cheap — it rides data the
// page already has.
function EditorDots({ entries, withNames = false }: { entries: Entry[]; withNames?: boolean }) {
  const seen = new Map<string, Entry>()
  for (const p of entries) {
    const key = p.author_login ?? p.author_name
    if (key && !seen.has(key)) seen.set(key, p)
  }
  const editors = [...seen.values()].slice(0, 3)
  if (editors.length === 0) return null
  const names = editors.map((p) => p.author_name ?? p.author_login).join(", ")
  return (
    <span className="flex items-center gap-1.5" title={names}>
      <span className="flex">
        {editors.map((p, i) => (
          <span
            key={p.author_login ?? p.author_name ?? p.short_id}
            className={cn(
              "grid size-4.5 place-items-center overflow-hidden rounded-full bg-secondary font-mono text-2xs font-semibold text-muted-foreground ring-1 ring-border",
              i > 0 && "-ml-1.5",
            )}
          >
            {p.author_avatar ? (
              <img src={p.author_avatar} alt="" className="size-full object-cover" />
            ) : (
              getInitials(p.author_name ?? p.author_login)
            )}
          </span>
        ))}
      </span>
      {withNames && (
        <span className="truncate font-mono text-2xs text-muted-foreground max-lg:hidden">
          {names}
        </span>
      )}
    </span>
  )
}

/** "Jul 28, 2026" — the index is a ledger, and a ledger gets real dates. */
const fullDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })

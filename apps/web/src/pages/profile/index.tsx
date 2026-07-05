import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { LayoutGrid, List } from "lucide-react"
import { type RefObject, useEffect, useRef, useState } from "react"
import { ApiError } from "@/api"
import { Icon } from "@/components/icons"
import { CardGrid } from "@/components/shared/card-grid"
import { EmptyState } from "@/components/shared/empty-state"
import { FollowButton } from "@/components/shared/follow-button"
import { PageShell } from "@/components/shared/page-shell"
import { SectionEyebrow } from "@/components/shared/section-eyebrow"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { UsernameForm } from "@/components/shared/username-form"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useAuth } from "@/ctx"
import { colorForName } from "@/lib/avatar-tints"
import { getInitials } from "@/lib/initials"
import { profileArtifactsQuery, profilePeopleQuery, profileQuery } from "@/lib/queries"
import { ProfilePending, ProfileWorkSkeleton } from "./skeleton"
import { ProfileWorkCard, ProfileWorkRow } from "./work-card"

const route = getRouteApi("/users/$handle")

// The rich public profile: an identity header (avatar, name, @handle, role, bio, GitHub
// link), a stats row (works / followers / following), a Follow button, and the person's
// work — everything the viewer is allowed to see, as a grid of live previews or a compact
// list. Header-first: the identity is preloaded in the route loader, so it paints with
// real data on the first frame (and a profile A→B nav never shows A's details while B
// loads); only the work grid carries its own load state.
export function Profile() {
  const { handle } = route.useParams()
  const { me, setMe } = useAuth()
  const nav = useNavigate()
  const [editing, setEditing] = useState(false)
  // The profile is the scroll container; the Work grid's infinite-scroll sentinel
  // observes against IT (not the viewport), so a short profile doesn't count its
  // below-the-fold sentinel as "in view" and fire an immediate extra page fetch.
  const scrollRef = useRef<HTMLDivElement>(null)

  const { data, isPending, isError, error, refetch } = useQuery(profileQuery(handle))

  // The identity is preloaded, so isPending here is only ever a genuine cold load; the
  // route's ProfilePending (same skeleton) already covers that window, so a null here
  // just avoids a double-frame.
  if (isPending) return <ProfilePending />

  // A transient fetch failure is status, not a genuine 404 — surface it as a recoverable
  // danger panel (matching the Work section + People), never the bare "No such profile".
  if (isError && !(error instanceof ApiError && error.status === 404)) {
    return (
      <PageShell className="grid min-h-full place-items-center">
        <StatusPanel
          tone="danger"
          title="Couldn’t load this profile"
          description="This is usually temporary."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="profile-retry"
              onClick={() => refetch()}
            >
              Try again
            </Button>
          }
        />
      </PageShell>
    )
  }

  if (isError || !data) {
    return (
      <PageShell className="grid min-h-full place-items-center">
        <div data-testid="profile-not-found">
          <EmptyState
            title="No such profile"
            description={
              <>
                There's no Derive user with the handle{" "}
                <span className="font-medium">@{handle}</span>.
              </>
            }
          />
        </div>
      </PageShell>
    )
  }

  const isMe = !!me?.username && me.username === data.username
  const initials = getInitials(data.name ?? data.username)
  const stats = data.stats ?? { works: 0, followers: 0, following: 0 }

  return (
    <PageShell scrollRef={scrollRef} className="flex flex-col gap-8">
      {/* The identity header sits flush on the canvas — whitespace over a card, per the
          surfaces doctrine (it's a page header, not a liftable object). */}
      <section data-testid="profile-card">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-6">
          <Avatar className="size-20 shrink-0 sm:size-24">
            {data.image && <AvatarImage src={data.image} alt={data.name ?? data.username} />}
            <AvatarFallback
              className="text-2xl font-medium text-scrim-foreground outline-1 -outline-offset-1 outline-foreground/10"
              style={{ backgroundColor: colorForName(data.name ?? data.username) }}
            >
              {initials}
            </AvatarFallback>
          </Avatar>

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {data.name && (
                  <h1
                    className="truncate font-serif text-2xl font-medium tracking-tight text-foreground"
                    data-testid="profile-name"
                  >
                    {data.name}
                  </h1>
                )}
                <p
                  className="font-mono text-sm text-muted-foreground"
                  data-testid="profile-username"
                >
                  @{data.username}
                </p>
              </div>
              <FollowButton username={data.username} className="shrink-0" />
            </div>

            {data.profession && (
              <p className="mt-2 text-sm font-medium text-foreground" data-testid="profile-role">
                {data.profession}
              </p>
            )}
            {data.about && (
              <p
                className="mt-1.5 text-sm text-pretty text-muted-foreground"
                data-testid="profile-about"
              >
                {data.about}
              </p>
            )}
            {data.github_login && (
              <a
                href={`https://github.com/${data.github_login}`}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="profile-github"
                className="mt-2.5 inline-flex items-center gap-1.5 font-mono text-2xs text-muted-foreground hover:text-primary"
              >
                <Icon name="link" size={12} />@{data.github_login} on GitHub
              </a>
            )}

            <div className="mt-4 flex items-center gap-5 text-sm" data-testid="profile-stats">
              <Stat label="works" value={stats.works} />
              <PeopleStat
                label="followers"
                value={stats.followers}
                handle={data.username}
                kind="followers"
              />
              <PeopleStat
                label="following"
                value={stats.following}
                handle={data.username}
                kind="following"
              />
            </div>

            {isMe && (
              <div className="mt-4">
                {editing ? (
                  <div className="max-w-xs">
                    <UsernameForm
                      initial={data.username}
                      submitLabel="Save username"
                      onClaimed={(username) => {
                        setMe(me ? { ...me, username } : me)
                        setEditing(false)
                        nav({ to: "/users/$handle", params: { handle: username } })
                      }}
                    />
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="profile-edit"
                    onClick={() => setEditing(true)}
                  >
                    Change username
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      <ProfileWork
        handle={data.username}
        isMe={isMe}
        name={data.name ?? data.username}
        scrollRef={scrollRef}
      />
    </PageShell>
  )
}

// Counts are the machine register: mono, tabular so they don't shimmy as they change.
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="font-mono font-medium tabular-nums text-foreground">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  )
}

// A clickable stat that opens a dialog listing the people, fetched lazily on open. The
// dialog's own header count reflects the LOADED list (not the profile's cached stat), so
// a just-changed follow can't show "12 followers" and open to an empty list.
function PeopleStat({
  label,
  value,
  handle,
  kind,
}: {
  label: string
  value: number
  handle: string
  kind: "followers" | "following"
}) {
  const [open, setOpen] = useState(false)
  const { data: people, isPending } = useQuery({
    ...profilePeopleQuery(handle, kind),
    enabled: open,
  })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          disabled={value === 0}
          data-testid={`profile-stat-${label}`}
          className="inline-flex items-baseline gap-1 rounded-sm underline-offset-4 outline-none enabled:hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default"
        >
          <span className="font-mono font-medium tabular-nums text-foreground">{value}</span>
          <span className="text-muted-foreground">{label}</span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-sm" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="capitalize">{label}</DialogTitle>
        </DialogHeader>
        {isPending ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : people && people.length > 0 ? (
          <ul role="list" className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {people.map((p) => (
              <li key={p.username}>
                <Link
                  to="/users/$handle"
                  params={{ handle: p.username }}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-3 rounded-md p-2 outline-none hover:bg-secondary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  <Avatar className="size-8">
                    {p.image && <AvatarImage src={p.image} alt={p.name ?? p.username} />}
                    <AvatarFallback
                      className="text-scrim-foreground outline-1 -outline-offset-1 outline-foreground/10"
                      style={{ backgroundColor: colorForName(p.name ?? p.username) }}
                    >
                      {getInitials(p.name ?? p.username)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="min-w-0">
                    {p.name && <span className="block truncate text-sm font-medium">{p.name}</span>}
                    <span className="block truncate font-mono text-2xs text-muted-foreground">
                      @{p.username}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">No one yet.</p>
        )}
      </DialogContent>
    </Dialog>
  )
}

// The person's work — an infinite grid/list, paged by keyset cursor. A sentinel pulls the
// next page as it scrolls into view (observed against the profile's scroll container, so
// a short profile doesn't fire an immediate extra fetch). Grid (live previews, the
// portfolio default) or list (scan a prolific profile by title) via a session toggle.
function ProfileWork({
  handle,
  isMe,
  name,
  scrollRef,
}: {
  handle: string
  isMe: boolean
  name: string
  scrollRef: RefObject<HTMLDivElement | null>
}) {
  const { data, isPending, isError, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } =
    useInfiniteQuery(profileArtifactsQuery(handle))
  const items = data?.pages.flatMap((p) => p.artifacts) ?? []
  const sentinel = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<"grid" | "list">("grid")

  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasNextPage) return
    // Observe against the profile's scroll container (null → viewport only as a fallback
    // before the ref attaches), so the sentinel counts as "in view" only when it actually
    // enters the scroll viewport — not the moment it mounts below the fold on a short profile.
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) fetchNextPage()
      },
      { root: scrollRef.current ?? null, rootMargin: "200px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, scrollRef])

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <SectionEyebrow className="flex-1">Work</SectionEyebrow>
        {/* The grid/list toggle only earns its place once there's work to reshape. */}
        {!isPending && !isError && items.length > 0 && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label="Work view"
            value={view}
            onValueChange={(v) => v && setView(v as "grid" | "list")}
          >
            <ToggleGroupItem value="grid" aria-label="Grid" data-testid="profile-work-view-grid">
              <LayoutGrid aria-hidden />
            </ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="List" data-testid="profile-work-view-list">
              <List aria-hidden />
            </ToggleGroupItem>
          </ToggleGroup>
        )}
      </div>
      {isPending ? (
        <div role="status">
          <span className="sr-only">Loading work…</span>
          <ProfileWorkSkeleton />
        </div>
      ) : isError ? (
        <StatusPanel
          tone="danger"
          title="Couldn’t load this work"
          description="This is usually temporary."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="profile-work-retry"
              onClick={() => refetch()}
            >
              Try again
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <div data-testid="profile-work-empty">
          <EmptyState
            icon={<Icon name="all" strokeWidth={1.75} />}
            title="Nothing published yet."
            description={
              isMe
                ? "Your public work shows up here once you publish."
                : `${name} hasn't published anything public yet.`
            }
          />
        </div>
      ) : (
        <>
          {view === "grid" ? (
            <div data-testid="profile-work-grid">
              <CardGrid>
                {items.map((a) => (
                  <ProfileWorkCard key={a.short_id} artifact={a} />
                ))}
              </CardGrid>
            </div>
          ) : (
            <div className="flex flex-col gap-2" data-testid="profile-work-list">
              {items.map((a) => (
                <ProfileWorkRow key={a.short_id} artifact={a} />
              ))}
            </div>
          )}
          <div ref={sentinel} className="h-8" />
          {isFetchingNextPage && (
            <div className="flex justify-center py-2">
              <Spinner />
            </div>
          )}
        </>
      )}
    </section>
  )
}

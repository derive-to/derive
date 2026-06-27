import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { api, type PublicProfile } from "@/api"
import { FollowButton } from "@/components/follow-button"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { CenteredSpinner, Spinner } from "@/components/shared/spinner"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { UsernameForm } from "@/components/username-form"
import { useAuth } from "@/ctx"
import { profileArtifactsQuery, profileQuery } from "@/lib/queries"
import { ProfileWorkCard } from "./profile-work-card"

const route = getRouteApi("/u/$handle")

// The rich public profile: an identity card (avatar, name, @handle, role, bio, GitHub
// link), a stats row (works / followers / following), a Follow button, and a grid of
// everything this person has worked on that the viewer is allowed to see. Single scroll;
// the activity feed of people you follow lives at the library's Following view.
export function Profile() {
  const { handle } = route.useParams()
  const { me, setMe } = useAuth()
  const nav = useNavigate()
  const [editing, setEditing] = useState(false)

  const { data, isPending, isError } = useQuery(profileQuery(handle))

  if (isPending) return <CenteredSpinner />

  if (isError || !data) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-sm text-center" data-testid="profile-not-found">
          <h1 className="font-display text-xl font-semibold text-foreground">No such profile</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            There's no Dock user with the handle <span className="font-medium">@{handle}</span>.
          </p>
        </div>
      </div>
    )
  }

  const isMe = !!me?.username && me.username === data.username
  const initials = (data.name ?? data.username).slice(0, 2).toUpperCase()
  const stats = data.stats ?? { works: 0, followers: 0, following: 0 }

  return (
    <div className="mx-auto w-full max-w-3xl p-6 sm:p-8">
      <Card className="p-6 sm:p-7" data-testid="profile-card">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-6">
          <Avatar className="size-20 shrink-0 sm:size-24">
            {data.image && <AvatarImage src={data.image} alt={data.name ?? data.username} />}
            <AvatarFallback className="text-2xl">{initials}</AvatarFallback>
          </Avatar>

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {data.name && (
                  <h1
                    className="truncate font-display text-2xl font-semibold text-foreground"
                    data-testid="profile-name"
                  >
                    {data.name}
                  </h1>
                )}
                <p
                  className="text-sm font-medium text-muted-foreground"
                  data-testid="profile-username"
                >
                  @{data.username}
                </p>
              </div>
              {/* Self-hides for a signed-out viewer or your own profile. */}
              <FollowButton username={data.username} className="shrink-0" />
            </div>

            {data.profession && (
              <p
                className="mt-2 text-sm font-medium text-accent-foreground"
                data-testid="profile-role"
              >
                {data.profession}
              </p>
            )}
            {data.about && (
              <p className="mt-1.5 text-sm text-muted-foreground" data-testid="profile-about">
                {data.about}
              </p>
            )}
            {data.github_login && (
              <a
                href={`https://github.com/${data.github_login}`}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="profile-github"
                className="mt-2.5 inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground transition-colors hover:text-primary"
              >
                <Icon name="link" size={13} />@{data.github_login} on GitHub
              </a>
            )}

            {/* Stats: works (static), followers + following (open a people dialog). */}
            <div className="mt-4 flex items-center gap-5 text-sm" data-testid="profile-stats">
              <Stat label="works" value={stats.works} />
              <PeopleStat
                label="followers"
                value={stats.followers}
                handle={data.username}
                load={() => api.profileFollowers(data.username).then((r) => r.users)}
              />
              <PeopleStat
                label="following"
                value={stats.following}
                handle={data.username}
                load={() => api.profileFollowing(data.username).then((r) => r.users)}
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
                        nav({ to: "/u/$handle", params: { handle: username } })
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
      </Card>

      <ProfileWork handle={data.username} isMe={isMe} name={data.name ?? data.username} />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="font-semibold text-foreground">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  )
}

// A clickable stat that opens a dialog listing the people, fetched lazily on open.
function PeopleStat({
  label,
  value,
  handle,
  load,
}: {
  label: string
  value: number
  handle: string
  load: () => Promise<PublicProfile[]>
}) {
  const [open, setOpen] = useState(false)
  const { data: people, isPending } = useQuery({
    queryKey: ["profile-people", handle, label],
    queryFn: load,
    enabled: open,
  })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          disabled={value === 0}
          data-testid={`profile-stat-${label}`}
          className="inline-flex items-baseline gap-1 rounded transition-colors hover:text-primary disabled:cursor-default disabled:hover:text-current"
        >
          <span className="font-semibold text-foreground">{value}</span>
          <span className="text-muted-foreground">{label}</span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="capitalize">{label}</DialogTitle>
        </DialogHeader>
        {isPending ? (
          <div className="py-6">
            <Spinner />
          </div>
        ) : people && people.length > 0 ? (
          <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {people.map((p) => (
              <li key={p.username}>
                <Link
                  to="/u/$handle"
                  params={{ handle: p.username }}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-hover"
                >
                  <Avatar className="size-8">
                    {p.image && <AvatarImage src={p.image} alt={p.name ?? p.username} />}
                    <AvatarFallback>
                      {(p.name ?? p.username).slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="min-w-0">
                    {p.name && <span className="block truncate text-sm font-medium">{p.name}</span>}
                    <span className="block truncate font-mono text-xs text-muted-foreground">
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

// The person's work — an infinite grid, paged by keyset cursor. A sentinel pulls the
// next page as it scrolls into view.
function ProfileWork({ handle, isMe, name }: { handle: string; isMe: boolean; name: string }) {
  const { data, isPending, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery(profileArtifactsQuery(handle))
  const items = data?.pages.flatMap((p) => p.artifacts) ?? []
  const sentinel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasNextPage) return
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !isFetchingNextPage) fetchNextPage()
    })
    io.observe(el)
    return () => io.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  return (
    <section className="mt-7">
      <h2 className="mb-3 font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Work
      </h2>
      {isPending ? (
        <div className="py-10">
          <Spinner />
        </div>
      ) : isError ? (
        <EmptyState>Couldn't load this work right now.</EmptyState>
      ) : items.length === 0 ? (
        <div data-testid="profile-work-empty">
          <EmptyState>
            {isMe
              ? "You haven't published anything public yet. Your public work shows up here."
              : `${name} hasn't published anything public yet.`}
          </EmptyState>
        </div>
      ) : (
        <>
          <div
            className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3"
            data-testid="profile-work-grid"
          >
            {items.map((a) => (
              <ProfileWorkCard key={a.short_id} artifact={a} />
            ))}
          </div>
          <div ref={sentinel} className="h-8" />
          {isFetchingNextPage && <Spinner />}
        </>
      )}
    </section>
  )
}

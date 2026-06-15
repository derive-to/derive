import { useQuery } from "@tanstack/react-query"
import { getRouteApi, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { api } from "@/api"
import { CenteredSpinner } from "@/components/shared/spinner"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { UsernameForm } from "@/components/username-form"
import { useAuth } from "@/ctx"

const route = getRouteApi("/u/$handle")

// A basic public profile (Profiles & Accounts v1): avatar, display name, and the
// @handle. Email stays private. The richer profile (your public artifacts,
// following, a customizable page) is intentionally out of scope here — this is
// the identity card the rest of that work builds on. When it's your own profile,
// you can rename your handle inline.
export function Profile() {
  const { handle } = route.useParams()
  const { me, setMe } = useAuth()
  const nav = useNavigate()
  const [editing, setEditing] = useState(false)

  const { data, isPending, isError } = useQuery({
    queryKey: ["profile", handle],
    queryFn: () => api.profile(handle).then((r) => r.user),
    retry: false,
  })

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

  return (
    <div className="mx-auto w-full max-w-xl p-6 sm:p-10">
      <Card className="flex flex-col items-center gap-4 p-8 text-center" data-testid="profile-card">
        <Avatar className="size-20">
          {data.image && <AvatarImage src={data.image} alt={data.name ?? data.username} />}
          <AvatarFallback className="text-lg">{initials}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          {data.name && (
            <h1
              className="font-display text-2xl font-semibold text-foreground"
              data-testid="profile-name"
            >
              {data.name}
            </h1>
          )}
          <p className="text-sm font-medium text-muted-foreground" data-testid="profile-username">
            @{data.username}
          </p>
        </div>

        {isMe &&
          (editing ? (
            <div className="w-full max-w-xs pt-2">
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
          ))}
      </Card>
    </div>
  )
}

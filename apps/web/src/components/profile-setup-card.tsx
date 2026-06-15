import { Camera } from "lucide-react"
import { useRef, useState } from "react"
import { api } from "@/api"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Card } from "@/components/ui/card"
import { UsernameForm } from "@/components/username-form"
import { useAuth } from "@/ctx"
import { suggestUsername } from "@/lib/username"

// The "finish your profile" card pinned at the top of the home page while a user
// has no handle yet. It sits above where you create your first artifact and see
// what's shared with you (no blocking screen). Claiming a username (and optionally
// a photo) clears it. The photo uploads immediately on pick; the handle commits on
// Save via the shared UsernameForm. Email is shown but stays private.
export function ProfileSetupCard() {
  const { me, setMe } = useAuth()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  if (!me) return null

  const initials = (me.name ?? me.email).slice(0, 2).toUpperCase()
  const pickPhoto = async (f: File | null) => {
    if (!f) return
    setUploading(true)
    try {
      const { image } = await api.uploadAvatar(f)
      setMe({ ...me, image })
    } catch {
      /* surfaced inline elsewhere; non-blocking */
    } finally {
      setUploading(false)
    }
  }

  return (
    <Card data-testid="profile-setup" className="mb-5.5 border-accent/40 bg-accent/5 p-4">
      <div className="font-display text-lg font-semibold text-foreground">Finish your profile</div>
      <p className="text-sm text-muted-foreground">
        Pick a username so people can find, @mention, and share with you. Add a photo if you like.
      </p>
      <div className="mt-4 flex flex-wrap items-start gap-4">
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            data-testid="profile-setup-avatar"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="group relative size-16 overflow-hidden rounded-full border border-dashed border-input transition-colors hover:border-primary disabled:opacity-60"
            aria-label="Add a profile photo"
          >
            <Avatar className="size-full rounded-full">
              {me.image && <AvatarImage src={me.image} alt="Your avatar" />}
              <AvatarFallback className="rounded-full bg-card text-muted-foreground">
                {me.name ? (
                  <span className="font-display text-xl font-semibold">{initials}</span>
                ) : (
                  <Camera className="size-5" aria-hidden />
                )}
              </AvatarFallback>
            </Avatar>
          </button>
          <span className="text-2xs text-muted-foreground">
            {uploading ? "Uploading…" : "Add a photo"}
          </span>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            data-testid="profile-setup-avatar-input"
            className="hidden"
            onChange={(e) => pickPhoto(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="min-w-[240px] flex-1">
          <UsernameForm
            initial={suggestUsername(me.email)}
            submitLabel="Save username"
            onClaimed={(username) => setMe({ ...me, username })}
          />
          <p className="mt-2 text-2xs text-muted-foreground">
            <span className="font-medium text-foreground">{me.email}</span> stays private.
          </p>
        </div>
      </div>
    </Card>
  )
}

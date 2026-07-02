import { Camera } from "lucide-react"
import { useRef, useState } from "react"
import { api } from "@/api"
import { ProfileFields } from "@/components/profile-fields"
import { SectionTitle } from "@/components/shared/section-title"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { UsernameForm } from "@/components/username-form"
import { useAuth } from "@/ctx"
import { getInitials } from "@/lib/initials"

// Your personal profile (vs the Workspace tab): photo, handle, role + "what you
// do", and people-search discoverability. The same fields onboarding collects, all
// editable here. First tab in Settings — "we'll do even more in here" over time.
export function ProfileSection() {
  const { me, setMe } = useAuth()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [discoverable, setDiscoverable] = useState(!!me?.discoverable)
  if (!me) return null

  const initials = getInitials(me.name ?? me.email)
  const pickPhoto = async (f: File | null) => {
    if (!f) return
    setUploading(true)
    try {
      const { image } = await api.uploadAvatar(f)
      setMe({ ...me, image })
    } catch {
      /* non-blocking; the avatar simply stays as-is */
    } finally {
      setUploading(false)
    }
  }

  const toggleDiscoverable = async () => {
    const next = !discoverable
    setDiscoverable(next) // optimistic
    try {
      await api.setDiscoverable(next)
      setMe({ ...me, discoverable: next })
    } catch {
      setDiscoverable(!next)
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        How you show up to your team across Derive: on your public profile, in the @mention picker,
        and the member directory. Your email always stays private.
      </p>

      {/* Photo + handle */}
      <Card className="p-4">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex flex-col items-center gap-1">
            <button
              type="button"
              data-testid="profile-avatar"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="group relative size-16 overflow-hidden rounded-full border border-dashed border-input outline-none hover:border-foreground/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
              aria-label="Change your profile photo"
            >
              <Avatar className="size-full rounded-full">
                {me.image && <AvatarImage src={me.image} alt="Your avatar" />}
                <AvatarFallback className="rounded-full">
                  {me.name ? (
                    <span className="text-xl font-medium">{initials}</span>
                  ) : (
                    <Camera className="size-5" strokeWidth={1.75} aria-hidden />
                  )}
                </AvatarFallback>
              </Avatar>
            </button>
            <span className="text-xs text-muted-foreground">
              {uploading ? "Uploading…" : me.image ? "Change" : "Add a photo"}
            </span>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              data-testid="profile-avatar-input"
              className="hidden"
              onChange={(e) => pickPhoto(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="flex min-w-[240px] flex-1 flex-col gap-2">
            <div className="text-sm font-medium leading-none">Username</div>
            <UsernameForm
              initial={me.username ?? ""}
              submitLabel={me.username ? "Update username" : "Save username"}
              onClaimed={(username) => setMe({ ...me, username })}
            />
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{me.email}</span> stays private.
            </p>
          </div>
        </div>
      </Card>

      {/* Role + what you do */}
      <Card className="p-4">
        <SectionTitle>Role</SectionTitle>
        <ProfileFields />
      </Card>

      {/* Discoverability */}
      <Card className="p-4">
        <SectionTitle>Discoverability</SectionTitle>
        <label className="flex items-start gap-2.5 text-sm text-foreground">
          <Checkbox
            data-testid="account-discoverable"
            checked={discoverable}
            onCheckedChange={toggleDiscoverable}
            className="mt-0.5"
          />
          <span>
            Let people find me by username in search.
            <span className="mt-0.5 block text-xs text-muted-foreground">
              On by default. Your @{me.username ?? "handle"}, name, role, and photo show up in
              people search; uncheck to hide yourself. Your email always stays private.
            </span>
          </span>
        </label>
      </Card>
    </section>
  )
}

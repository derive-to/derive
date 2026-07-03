import { useState } from "react"
import { api } from "@/api"
import { ProfileFields } from "@/components/profile-fields"
import { AvatarPicker } from "@/components/shared/avatar-picker"
import { FormField } from "@/components/shared/form-field"
import { SectionTitle } from "@/components/shared/section-title"
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
    <section className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        How you show up to your team across Derive: on your public profile, in the @mention picker,
        and the member directory. Your email always stays private.
      </p>

      {/* Photo + handle */}
      <Card className="p-4">
        <div className="flex flex-wrap items-start gap-4">
          <AvatarPicker
            image={me.image}
            initials={me.name ? initials : null}
            uploading={uploading}
            onPick={pickPhoto}
            ariaLabel="Change your profile photo"
            testId="profile-avatar"
          />
          <FormField
            label="Username"
            className="min-w-60 flex-1"
            hint={
              <>
                <span className="font-medium text-foreground">{me.email}</span> stays private.
              </>
            }
          >
            <UsernameForm
              initial={me.username ?? ""}
              submitLabel={me.username ? "Update username" : "Save username"}
              onClaimed={(username) => setMe({ ...me, username })}
            />
          </FormField>
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
            <span className="mt-0.5 block text-sm text-muted-foreground">
              On by default. Your @{me.username ?? "handle"}, name, role, and photo show up in
              people search; uncheck to hide yourself. Your email always stays private.
            </span>
          </span>
        </label>
      </Card>
    </section>
  )
}

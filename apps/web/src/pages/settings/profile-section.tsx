import { useState } from "react"
import { api } from "@/api"
import { AvatarPicker } from "@/components/shared/avatar-picker"
import { FormField } from "@/components/shared/form-field"
import { ProfileFields } from "@/components/shared/profile-fields"
import { SectionTitle } from "@/components/shared/section-title"
import { SettingRow } from "@/components/shared/setting-row"
import { SettingsGroup } from "@/components/shared/settings-group"
import { UsernameForm } from "@/components/shared/username-form"
import { Switch } from "@/components/ui/switch"
import { useAuth } from "@/ctx"
import { getInitials } from "@/lib/initials"
import { SettingsSection } from "./settings-section"

// Your personal profile (vs. the Workspace sections): photo, handle, role +
// "what you do", and people-search discoverability. The same fields onboarding
// collects, all editable here — laid out as identity → role → a discoverability
// toggle, on the page surface (no card stack).
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

  const toggleDiscoverable = async (next: boolean) => {
    setDiscoverable(next) // optimistic
    try {
      await api.setDiscoverable(next)
      setMe({ ...me, discoverable: next })
    } catch {
      setDiscoverable(!next)
    }
  }

  return (
    <SettingsSection
      title="Profile"
      description="How you show up across Derive — your public profile, the @mention picker, and the member directory. Your email always stays private."
    >
      {/* Identity: photo + handle. */}
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

      {/* Role + what you do — ProfileFields self-labels "Your role" / "What you do",
          so the group heading groups them without echoing "Role". */}
      <div className="flex flex-col gap-3">
        <SectionTitle>About you</SectionTitle>
        <ProfileFields />
      </div>

      {/* Discoverability — an instant toggle, no save. */}
      <SettingsGroup title="Discoverability">
        <SettingRow
          htmlFor="account-discoverable"
          label="Public profile"
          description={`On by default. Your profile at @${me.username ?? "handle"} — name, role, photo, and public work — is visible to anyone, and you appear in people search. Turn it off and only people who share a workspace with you can see it.`}
        >
          <Switch
            id="account-discoverable"
            data-testid="account-discoverable"
            checked={discoverable}
            onCheckedChange={toggleDiscoverable}
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>
  )
}

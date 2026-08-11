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
import { useApiMutation } from "@/lib/use-api-mutation"
import { SettingsSection } from "./settings-section"

// Your personal profile (vs. the Workspace sections): photo, handle, role +
// "what you do", and people-search discoverability. The same fields onboarding
// collects, all editable here — laid out as identity → role → a discoverability
// toggle, on the page surface (no card stack).
export function ProfileSection() {
  const { me, setMe } = useAuth()
  const [discoverable, setDiscoverable] = useState(!!me?.discoverable)
  // Avatar upload is non-blocking (a failure leaves the current photo as-is) but NOT silent —
  // a failed upload toasts via the safety net, so the user isn't misled that it saved.
  const avatar = useApiMutation({
    mutationFn: (f: File) => api.uploadAvatar(f),
    onSuccess: ({ image }) => {
      if (me) setMe({ ...me, image })
    },
  })
  // Discoverability toggle: optimistic, and its own visual revert IS the failure signal —
  // so it stays quiet (errorToast:false), matching the original.
  const discoverableMut = useApiMutation({
    mutationFn: (next: boolean) => api.setDiscoverable(next),
    errorToast: false,
    optimistic: (next) => {
      setDiscoverable(next)
      return () => setDiscoverable(!next)
    },
    onSuccess: (_data, next) => {
      if (me) setMe({ ...me, discoverable: next })
    },
  })
  if (!me) return null

  const initials = getInitials(me.name ?? me.email)
  const pickPhoto = (f: File | null) => {
    if (f) avatar.mutate(f)
  }
  const toggleDiscoverable = (next: boolean) => discoverableMut.mutate(next)

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
          uploading={avatar.isPending}
          onPick={pickPhoto}
          ariaLabel="Change your profile photo"
          testId="profile-avatar"
        />
        <FormField
          label="Username"
          className="min-w-60 flex-1"
          // The address is a fact, not the emphasis: bolding it made the hint
          // louder than the field label above it.
          hint={`${me.email} stays private.`}
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
          description={`Anyone can see your name, role, photo, and public work at @${me.username ?? "handle"}, and you turn up in people search. Off means only workspace-mates find you.`}
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

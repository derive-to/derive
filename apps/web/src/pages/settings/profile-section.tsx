import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { type AuthCapabilities, api } from "@/api"
import { AvatarPicker } from "@/components/shared/avatar-picker"
import { FormField } from "@/components/shared/form-field"
import { LoadError } from "@/components/shared/load-error"
import { ProfileFields } from "@/components/shared/profile-fields"
import { SectionTitle } from "@/components/shared/section-title"
import { SettingRow } from "@/components/shared/setting-row"
import { SettingsGroup } from "@/components/shared/settings-group"
import { UsernameForm } from "@/components/shared/username-form"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"
import { Switch } from "@/components/ui/switch"
import { useAuth } from "@/ctx"
import { getInitials } from "@/lib/initials"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useOneShotParams } from "@/lib/use-one-shot-params"
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
      description="Choose how you appear on your public profile, in mentions, and in the member directory. Your email stays private."
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

      <GithubAccount />

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

// Where the link flow lands, both ways. Better Auth sends the browser here with ?error= when
// GitHub or the link was refused; the toast says so once and the address is cleaned.
const LINK_RETURN = "/settings/profile"
const LINK_ERRORS: Record<string, string> = {
  account_already_linked_to_different_user:
    "That GitHub account is already linked to another Derive account.",
  unable_to_link_account: "That GitHub account couldn't be linked.",
  access_denied: "GitHub access was declined, so nothing was linked.",
}

// A GitHub identity attached to this account: what lets @Derive on a pull request act as the
// person who commented, and from then on also a way to sign in. Linking goes to GitHub and
// back. Shown only where GitHub sign-in is configured, since the link rides the same OAuth app.
function GithubAccount() {
  const qc = useQueryClient()
  // Same shape as Security's capability read: absent (or unreadable) means the group is not
  // shown, which is also the right answer for a self-host without GitHub sign-in.
  const [caps, setCaps] = useState<AuthCapabilities | null>(null)
  useEffect(() => {
    api
      .capabilities()
      .then(setCaps)
      .catch(() => setCaps(null))
  }, [])
  const {
    data: link,
    isPending,
    isError,
    refetch,
  } = useQuery({ queryKey: ["github-link"], queryFn: () => api.githubLink() })
  const { error: linkError } = useOneShotParams("error", "error_description")
  // biome-ignore lint/correctness/useExhaustiveDependencies: the param is read once on mount
  useEffect(() => {
    if (!linkError) return
    // Reports the redirect back from GitHub, not a mutation of ours.
    toast.error(LINK_ERRORS[linkError] ?? "GitHub didn't link. Try again.") // mutation-ignore: redirect outcome
  }, [])
  // Linking navigates away on success, so the button stays busy until the page is gone.
  const [leaving, setLeaving] = useState(false)
  const linkMut = useApiMutation({
    mutationFn: () => api.linkGithub(LINK_RETURN),
    onSuccess: () => setLeaving(true),
  })
  const unlinkMut = useApiMutation({
    mutationFn: () => api.unlinkGithub(link?.account_id ?? null),
    success: "GitHub unlinked",
    invalidate: [["github-link"]],
    onSuccess: () =>
      qc.setQueryData(["github-link"], { linked: false, account_id: null, login: null }),
  })
  if (!caps?.github) return null

  const linked = link?.linked === true
  const login = link?.login
  const description = isPending
    ? "Checking…"
    : linked
      ? `${login ? `Linked as @${login}.` : "Linked."} @Derive on a pull request knows it's you, and you can sign in with GitHub too.`
      : "Link it so @Derive on a pull request knows it's you. You'll be able to sign in with GitHub too."

  return (
    <SettingsGroup title="GitHub">
      {isError ? (
        <div>
          <LoadError
            layout="inline"
            title="Couldn’t check your GitHub link"
            testId="github-link-retry"
            onRetry={() => refetch()}
          />
        </div>
      ) : (
        <SettingRow label="GitHub account" description={description}>
          {linked ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => unlinkMut.mutate()}
              loading={unlinkMut.isPending}
              data-testid="github-unlink"
            >
              Unlink
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => linkMut.mutate()}
              loading={linkMut.isPending || leaving}
              disabled={isPending}
              data-testid="github-link"
            >
              Link GitHub
            </Button>
          )}
        </SettingRow>
      )}
    </SettingsGroup>
  )
}

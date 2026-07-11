import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { ApiError, api } from "@/api"
import { Icon } from "@/components/icons"
import { AvatarPicker } from "@/components/shared/avatar-picker"
import { ConnectAgent } from "@/components/shared/connect-agent"
import { fieldError } from "@/components/shared/field-error"
import { FormField } from "@/components/shared/form-field"
import { SectionEyebrow } from "@/components/shared/section-eyebrow"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "@/components/ui/sonner"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/ctx"
import { authClient } from "@/lib/auth-client"
import { getInitials } from "@/lib/initials"
import { OTHER, PROFESSIONS, presetFor } from "@/lib/professions"
import { workspaceQuery, workspaceSettingsQuery } from "@/lib/queries"
import { STORAGE_KEYS } from "@/lib/storage-keys"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { normalizeUsername, usernameError } from "@/lib/username"
import { notesAsDoc, useBrandprintImport } from "@/pages/brandprint/use-brandprint-import"

// A present account — the stateful onboarding body only mounts once `me` resolves
// (see Welcome's guard), so the profile fields can safely initialize from it.
type Account = NonNullable<ReturnType<typeof useAuth>["me"]>

// Set once the user finishes (or skips) onboarding, so the post-signup redirect
// (app-shell.tsx) doesn't bounce them back here on every visit.
export const markOnboarded = () => {
  // Persist server-side (authoritative + cross-device) and cache locally for an instant
  // guard on the very next nav. Fire-and-forget: the localStorage cache covers the gap
  // while the request is in flight, and the flag is one-way, so a dropped write just
  // re-shows /welcome once rather than corrupting anything.
  api.setOnboarded().catch(() => {})
  try {
    localStorage.setItem(STORAGE_KEYS.onboarded, "1")
  } catch {
    /* private mode — the in-session redirect guard still won't loop */
  }
}

// Distinguishes a failed Brandprint seed from a failed profile save in the one
// Continue action, so the inline error says which half to retry.
const BRANDPRINT_FAILED = "brandprint-seed-failed"

// Gate on the session BEFORE the stateful body so the profile fields initialize from
// a resolved account (a direct visit to /welcome renders once with me=null first).
export function Welcome() {
  useDocumentTitle("Welcome")
  const { me } = useAuth()
  if (!me) return null
  return <Onboarding me={me} />
}

function Onboarding({ me }: { me: Account }) {
  const { setMe } = useAuth()
  const nav = useNavigate()

  // Profile state lives on the page (not a child) so the single primary action —
  // "Continue to Derive" — persists it and advances in one step. The old flow had a
  // separate "Save profile" button, so filled fields were silently lost if you hit
  // Continue without saving first.
  const [handle, setHandle] = useState(me.username ?? "")
  const [preset, setPreset] = useState(presetFor(me.profession ?? null))
  const [custom, setCustom] = useState(
    me.profession && presetFor(me.profession) === OTHER ? me.profession : "",
  )
  const [about, setAbout] = useState(me.about ?? "")
  const [brandNotes, setBrandNotes] = useState("")

  // Step 3 shows only to the person who'd be setting up this workspace's Brandprint
  // for the first time: an owner of a workspace that has none (the spec's "first on
  // the team" rule — everyone else inherits it over MCP with nothing to set up).
  // Degrade-by-design: the step is optional, so a failed read hides it rather than
  // blocking onboarding behind a retry.
  const { data: ws, isError: wsError } = useQuery(workspaceQuery())
  const { data: wsSettings, isError: settingsError } = useQuery(workspaceSettingsQuery())
  const showBrandprint =
    !wsError &&
    !settingsError &&
    ws?.role === "owner" &&
    !!wsSettings &&
    !wsSettings.brandprint?.collectionId
  const seedBrandprint = useBrandprintImport("workspace", "")

  const firstName = (me.name ?? me.username ?? me.email).split(/[@\s]/)[0]
  const initials = getInitials(me.name ?? me.email)
  const normalized = normalizeUsername(handle)
  const handleErr = normalized ? usernameError(normalized) : null
  const usernameField = fieldError("welcome-username-error", handleErr)
  const profession = preset === OTHER ? custom.trim() : preset

  // Non-blocking (onboarding proceeds regardless) but NOT silent: a failed upload toasts, so
  // the user isn't left believing a photo saved when it didn't.
  const upload = useApiMutation({
    mutationFn: (f: File) => api.uploadAvatar(f),
    onSuccess: ({ image }) => setMe({ ...me, image }),
  })
  const pickPhoto = (f: File | null) => {
    if (f) upload.mutate(f)
  }

  // Skip = leave now, persist nothing. Continue = save the profile (handle + role +
  // bio) and THEN enter — the one action that finishes onboarding without dropping
  // input. Both set the onboarded flag so the app-shell gate won't bounce back here.
  const skip = () => {
    markOnboarded()
    nav({ to: "/" })
  }

  const save = useApiMutation({
    mutationFn: async () => {
      // The Brandprint seeds FIRST: a failure keeps the user here with their notes
      // intact (nothing else has saved yet). On retry the settings cache already
      // shows the pointer, so a seeded Brandprint is never doubled.
      if (showBrandprint && brandNotes.trim()) {
        try {
          await seedBrandprint.mutateAsync([notesAsDoc(brandNotes)])
        } catch {
          throw new Error(BRANDPRINT_FAILED)
        }
      }
      let username = me.username
      // Only claim when it actually changed (claiming your own handle is a no-op, but
      // skipping avoids a needless round-trip).
      if (normalized && normalized !== me.username) {
        const r = await api.setUsername(normalized)
        username = r.username
      }
      const res = await api.setProfile({ profession, about: about.trim() })
      return { username, profession: res.profession, about: res.about }
    },
    errorToast: false,
    onSuccess: ({ username, profession: prof, about: bio }) => {
      setMe({ ...me, username, profession: prof, about: bio, onboarded: true })
      markOnboarded()
      nav({ to: "/" })
    },
  })
  // Preserve the original message logic: the server's message for a known ApiError, a
  // friendly fallback for anything else.
  const saveErr = save.error
    ? save.error.message === BRANDPRINT_FAILED
      ? "Couldn't save your Brandprint. Try again, or clear the box to skip it for now."
      : save.error instanceof ApiError
        ? save.error.message
        : "Could not save your profile."
    : ""
  const continueToApp = () => {
    if (!handleErr) save.mutate()
  }

  return (
    <div className="min-h-dvh bg-background">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-5 py-10 sm:px-8 sm:py-14">
        <div className="flex flex-col gap-1.5">
          {/* First-run greeting — a voice moment, so it renders in Geist display. */}
          <h1 className="font-serif text-2xl font-medium tracking-tight text-balance text-foreground sm:text-3xl">
            Welcome to Derive, {firstName}.
          </h1>
          <p className="text-sm text-pretty text-muted-foreground">
            A minute of setup — tell us who you are, then connect an agent to publish your first
            artifact. You can change any of this later in Settings.
          </p>
        </div>

        {/* Step 1 — Your profile. No per-section save: Continue persists it. */}
        <section className="flex flex-col gap-4">
          <SectionEyebrow as="h2">Step 1 · Your profile</SectionEyebrow>
          <div className="flex flex-wrap items-start gap-4">
            {/* Your own initials take the soft brand tint (the user-pod idiom). */}
            <AvatarPicker
              image={me.image}
              initials={me.name ? initials : null}
              uploading={upload.isPending}
              onPick={pickPhoto}
              ariaLabel="Add a profile photo"
              testId="welcome-avatar"
              fallbackClassName={me.name ? "bg-primary/10 text-primary" : undefined}
            />

            <div className="flex min-w-65 flex-1 flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <FormField
                  label="Username"
                  htmlFor="welcome-username"
                  className="min-w-37.5 flex-1"
                >
                  <InputGroup>
                    <InputGroupAddon>
                      <InputGroupText>@</InputGroupText>
                    </InputGroupAddon>
                    <InputGroupInput
                      id="welcome-username"
                      data-testid="welcome-username"
                      {...usernameField.aria}
                      name="username"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      value={handle}
                      onChange={(e) => {
                        setHandle(e.target.value)
                        save.reset()
                      }}
                      placeholder="yourname"
                    />
                  </InputGroup>
                </FormField>
                <FormField label="Role" className="w-37.5">
                  <Select value={preset || undefined} onValueChange={setPreset}>
                    <SelectTrigger
                      data-testid="welcome-role"
                      aria-label="Your role"
                      className="w-full"
                    >
                      <SelectValue placeholder="Who are you?" />
                    </SelectTrigger>
                    <SelectContent>
                      {PROFESSIONS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          {p.value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              </div>
              {usernameField.node ?? (
                <p className="text-sm text-muted-foreground">
                  Letters, numbers, and single - or _.
                </p>
              )}

              {preset === OTHER && (
                <Input
                  data-testid="welcome-role-other"
                  aria-label="Custom role"
                  name="custom-role"
                  value={custom}
                  maxLength={40}
                  placeholder="e.g. Data, Sales, Ops…"
                  onChange={(e) => setCustom(e.target.value)}
                />
              )}

              <FormField
                label="What you do"
                htmlFor="welcome-about"
                count={about.length}
                maxLength={280}
              >
                <Textarea
                  id="welcome-about"
                  data-testid="welcome-about"
                  name="about"
                  value={about}
                  maxLength={280}
                  rows={2}
                  placeholder="A line about what you work on, so teammates and agents know who you are."
                  onChange={(e) => setAbout(e.target.value)}
                />
              </FormField>

              {saveErr && (
                // The house form-error surface (matches Login): StatusPanel inline
                // danger announces via role="alert"; the wrapper only carries the id.
                <div data-testid="welcome-profile-error">
                  <StatusPanel tone="danger" layout="inline" title={saveErr} />
                </div>
              )}

              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{me.email}</span> stays private.
              </p>
            </div>
          </div>
        </section>

        {/* An optional, quiet passkey nudge between the two steps — set up the
            phishing-resistant one-tap sign-in now, or skip and do it later in Settings. */}
        <PasskeyNudge />

        {/* Step 2 — Connect an agent: the activation moment. The block itself is the
            shared ConnectAgent surface (also behind the library's connect empty state
            and the Brandprint nudge), so every entry point renders the same thing. */}
        <section className="flex flex-col gap-4">
          <SectionEyebrow as="h2">Step 2 · Connect an agent</SectionEyebrow>
          <ConnectAgent testidPrefix="welcome" />
        </section>

        {showBrandprint && <BrandprintStep notes={brandNotes} onNotes={setBrandNotes} />}

        {/* Finish — one primary action that saves the profile and enters; skip leaves
            now without saving. */}
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="ghost"
            data-testid="welcome-skip"
            className="text-muted-foreground"
            onClick={skip}
          >
            Skip for now
          </Button>
          <Button
            variant="default"
            data-testid="welcome-continue"
            onClick={continueToApp}
            loading={save.isPending}
            disabled={!!handleErr}
          >
            {save.isPending ? "Finishing…" : "Continue to Derive"}
          </Button>
        </div>

        {/* Deliberately a line, not a step: teams are created at first need
            (Settings, or the share dialog's hint), never chosen at signup. */}
        <p className="text-center text-sm text-muted-foreground">
          Working with a team? Create a workspace and invite them anytime from Settings.
        </p>
      </div>
    </div>
  )
}

// Step 3 — the workspace Brandprint, seeded from pasted notes (spec: onboarding is
// workspace-scoped and conditional; the caller gates rendering). Deliberately one
// textarea: files, look/read categories, and the collection picker live on the
// /brandprint page — this step is the lightest useful capture, saved by the page's
// single Continue action so nothing needs its own save button.
function BrandprintStep({ notes, onNotes }: { notes: string; onNotes: (v: string) => void }) {
  return (
    <section className="flex flex-col gap-4">
      <SectionEyebrow as="h2">Step 3 · Your team's Brandprint (optional)</SectionEyebrow>
      <p className="text-sm text-pretty text-muted-foreground">
        A Brandprint is your team's style in one place: your tone of voice, formatting rules, words
        to use or avoid, and colors. Every agent that works in Derive reads it automatically before
        it creates or revises anything, so the work matches your brand from the first draft, with no
        one re-explaining it each time. Set it once here and everyone who joins your team inherits
        it.
      </p>
      <Textarea
        value={notes}
        rows={5}
        placeholder="Paste your brand guidelines, or a sample doc that already sounds right…"
        aria-label="Your team's brand notes"
        data-testid="welcome-brandprint"
        onChange={(e) => onNotes(e.target.value)}
      />
      <p className="text-sm text-muted-foreground">
        Saves when you continue, and starts guiding agents the moment one is connected. Your agent
        then assembles your team's brand profile from it — finish on the Brandprint page.
      </p>
    </section>
  )
}

// A quiet, skippable passkey affordance — shown only where passkeys are supported and only
// until one is added. Runs the browser create-credential ceremony via the auth client; a
// cancel is silent, a success swaps to a "you're set" line.
function PasskeyNudge() {
  const [supported, setSupported] = useState(false)
  const [added, setAdded] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api
      .capabilities()
      .then((c) => setSupported(c.passkey))
      .catch(() => setSupported(false))
  }, [])
  if (!supported || added) {
    if (!added) return null
    return (
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Icon name="check" className="text-success" /> Passkey added — you can sign in with one tap.
      </p>
    )
  }
  const add = async () => {
    setBusy(true)
    try {
      const res = await authClient.passkey.addPasskey()
      if (res?.error) throw new Error(res.error.message ?? "")
      setAdded(true)
      toast.success("Passkey added")
    } catch (e) {
      const msg = (e as Error).message
      // mutation-ignore: WebAuthn cancel/abort must stay silent; the primitive has no
      // per-error suppression, so this passkey add is deliberately hand-rolled.
      if (msg && !/cancel|abort|NotAllowed/i.test(msg)) toast.error(msg) // mutation-ignore
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-secondary/40 px-4 py-3">
      <p className="text-sm text-pretty text-muted-foreground">
        <span className="font-medium text-foreground">Add a passkey</span> for a phishing-resistant,
        one-tap sign-in. Optional — you can also do this later in Settings.
      </p>
      <Button
        variant="secondary"
        size="sm"
        onClick={add}
        loading={busy}
        data-testid="welcome-add-passkey"
      >
        {busy ? "Waiting…" : "Add passkey"}
      </Button>
    </div>
  )
}

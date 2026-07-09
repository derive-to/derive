import { useNavigate } from "@tanstack/react-router"
import { Copy } from "lucide-react"
import { useEffect, useState } from "react"
import { ApiError, api } from "@/api"
import { Icon } from "@/components/icons"
import { AvatarPicker } from "@/components/shared/avatar-picker"
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
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/ctx"
import { authClient } from "@/lib/auth-client"
import { getInitials } from "@/lib/initials"
import { OTHER, PROFESSIONS, presetFor } from "@/lib/professions"
import { STORAGE_KEYS } from "@/lib/storage-keys"
import { useApiMutation } from "@/lib/use-api-mutation"
import { normalizeUsername, usernameError } from "@/lib/username"

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

// The public origin to hand an agent. A deployed Derive instance's own origin IS its
// public URL, so that's what we embed — except in local dev (localhost), where we
// fall back to a clearly-editable placeholder so nobody copies an unreachable URL.
const PLACEHOLDER_URL = "https://your-derive-server.com"
const publicUrlOf = (origin: string) =>
  /localhost|127\.0\.0\.1|\[::1\]/.test(origin) ? PLACEHOLDER_URL : origin

// Hosted: Derive is already running (this instance, or any you point at). The fastest
// on-ramp — Derive is itself a remote MCP server, so one line connects an agent and it
// gets every Derive tool. No CLI needed for the publish/review loop.
const hostedPrompt = (url: string) =>
  `Connect me to Derive, a living-docs tool that hosts pages/docs at permanent, versioned URLs with inline review comments. Derive is a remote MCP server.

Derive is running at: ${url}

Please:
1. Add it over MCP. In Claude Code run:
     claude mcp add --transport http derive ${url}/mcp
   In another harness, add an HTTP/streamable MCP server named "derive" at ${url}/mcp.
   The first call opens a browser consent (OAuth); the scope I grant maps to my Derive role.
2. Confirm it's connected by calling the "whoami" MCP tool, then "list_artifacts".

Once connected you can publish a page, read its review comments, and run the propose -> review -> revise loop — all over MCP.`

// Self-host: run Derive yourself first, then connect. Mirrors DEPLOY.md's single-
// container quickstart; the MCP endpoint is always <your BASE_URL>/mcp.
const selfHostPrompt = () =>
  `Set up a self-hosted Derive for me, then connect this agent to it. Derive is an open-source living-docs tool (permanent versioned URLs + inline review comments) that is itself a remote MCP server.

Please:
1. From a Derive checkout (the directory with deploy/Dockerfile), run the single-container image (state lives in the derive_data volume):
     docker build -f deploy/Dockerfile -t derive .
     docker run -d -p 8080:8080 -v derive_data:/data \\
       -e DERIVE_AUTH_SECRET="$(openssl rand -hex 32)" \\
       -e BASE_URL="https://derive.example.com" \\
       derive
   Set BASE_URL to the public https URL I'll actually reach it at (behind a TLS proxy — not localhost). For a quick local-only trial, BASE_URL=http://localhost:8080 works.
2. Connect over MCP, using that same BASE_URL:
     claude mcp add --transport http derive <BASE_URL>/mcp
   The first call opens a browser consent (OAuth).
3. Confirm by calling the "whoami" MCP tool, then "list_artifacts".

Then you can publish, read review comments, and run the propose -> review -> revise loop over MCP.`

// Gate on the session BEFORE the stateful body so the profile fields initialize from
// a resolved account (a direct visit to /welcome renders once with me=null first).
export function Welcome() {
  const { me } = useAuth()
  if (!me) return null
  return <Onboarding me={me} />
}

function Onboarding({ me }: { me: Account }) {
  const { setMe } = useAuth()
  const nav = useNavigate()
  // Self-host mode swaps the connect snippet for run-it-yourself instructions.
  const [devMode, setDevMode] = useState(false)

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

  const publicUrl =
    typeof window !== "undefined" ? publicUrlOf(window.location.origin) : PLACEHOLDER_URL
  const hostedText = hostedPrompt(publicUrl)
  const devText = selfHostPrompt()

  const firstName = (me.name ?? me.username ?? me.email).split(/[@\s]/)[0]
  const initials = getInitials(me.name ?? me.email)
  const normalized = normalizeUsername(handle)
  const handleErr = normalized ? usernameError(normalized) : null
  const profession = preset === OTHER ? custom.trim() : preset

  // Non-blocking by design: a failed avatar upload stays quiet (errorToast:false, no
  // inline error) — the rest of onboarding proceeds regardless.
  const upload = useApiMutation({
    mutationFn: (f: File) => api.uploadAvatar(f),
    errorToast: false,
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
    ? save.error instanceof ApiError
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
                <FormField label="Username" className="min-w-37.5 flex-1">
                  <InputGroup>
                    <InputGroupAddon>
                      <InputGroupText>@</InputGroupText>
                    </InputGroupAddon>
                    <InputGroupInput
                      data-testid="welcome-username"
                      aria-label="Username"
                      aria-invalid={!!handleErr}
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

              <FormField label="What you do" htmlFor="welcome-about">
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

              {(saveErr || handleErr) && (
                // The house form-error surface (matches Login): StatusPanel inline
                // danger announces via role="alert"; the wrapper only carries the id.
                <div data-testid="welcome-profile-error">
                  <StatusPanel tone="danger" layout="inline" title={saveErr || handleErr} />
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

        {/* Step 2 — Connect an agent: the activation moment (paste-into-an-agent). */}
        <section className="flex flex-col gap-4">
          <SectionEyebrow as="h2">Step 2 · Connect an agent</SectionEyebrow>
          <p className="text-sm text-pretty text-muted-foreground">
            {devMode
              ? "Spin up your own Derive, then connect your agent to it. Paste this into Claude Code, Codex, or any agent."
              : "Paste this into Claude Code, Codex, ChatGPT, or any agent — it connects Derive so the agent can publish, review, and revise for you."}
          </p>
          <div className="flex flex-col gap-2">
            {/* The self-host switch rides just above the snippet it swaps — a rarely-
                touched option, so it sits quiet and right-aligned, not in the header. */}
            <label className="flex items-center gap-1.5 self-end text-sm font-medium text-muted-foreground">
              <span>Self-host mode</span>
              <Switch
                checked={devMode}
                aria-label="Self-host mode"
                data-testid="welcome-dev-toggle"
                onCheckedChange={setDevMode}
              />
            </label>
            <PromptBlock
              key={devMode ? "dev" : "hosted"}
              text={devMode ? devText : hostedText}
              testid="welcome-prompt"
            />
          </div>
        </section>

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

// A copyable prompt block: the scrollable text + a copy button that owns its own
// "copied" tick, so each tab's block has independent state.
function PromptBlock({ text, testid }: { text: string; testid: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      toast.success("Copied — paste it into your agent")
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Couldn't copy; select the text and copy it manually")
    }
  }
  return (
    <div className="relative">
      {/* The machine register on a quiet well: mono text, bg-secondary, hairline edge. */}
      <pre
        data-testid={testid}
        className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border bg-secondary p-3 pr-12 font-mono text-sm text-foreground"
      >
        {text}
      </pre>
      <Button
        variant="outline"
        size="icon-sm"
        data-testid={`${testid}-copy`}
        aria-label="Copy setup prompt"
        className="absolute right-2 top-2"
        onClick={copy}
      >
        {copied ? <Icon name="check" className="text-success" /> : <Copy className="size-4" />}
      </Button>
    </div>
  )
}

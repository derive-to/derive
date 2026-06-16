import { useNavigate } from "@tanstack/react-router"
import { Camera, Check, Copy } from "lucide-react"
import { useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { api } from "@/api"
import { ProfileFields } from "@/components/profile-fields"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { UsernameForm } from "@/components/username-form"
import { useAuth } from "@/ctx"
import { cn } from "@/lib/utils"

// Set once the user finishes (or skips) onboarding, so the post-signup redirect
// (app-shell.tsx) doesn't bounce them back here on every visit.
export const ONBOARDED_KEY = "dock:onboarded"

export const markOnboarded = () => {
  try {
    localStorage.setItem(ONBOARDED_KEY, "1")
  } catch {
    /* private mode — the in-session redirect guard still won't loop */
  }
}

// The public origin to hand an agent. A deployed Dock instance's own origin IS its
// public URL, so that's what we embed — except in local dev (localhost), where we
// fall back to a clearly-editable placeholder so nobody copies an unreachable URL.
const PLACEHOLDER_URL = "https://your-dock-server.com"
const publicUrlOf = (origin: string) =>
  /localhost|127\.0\.0\.1|\[::1\]/.test(origin) ? PLACEHOLDER_URL : origin

// Hosted: Dock is already running (this instance, or any you point at). The fastest
// on-ramp — Dock is itself a remote MCP server, so one line connects an agent and it
// gets every Dock tool. No CLI needed for the publish/review loop.
const hostedPrompt = (url: string) =>
  `Connect me to Dock, a living-docs tool that hosts pages/docs at permanent, versioned URLs with inline review comments. Dock is a remote MCP server.

Dock is running at: ${url}

Please:
1. Add it over MCP. In Claude Code run:
     claude mcp add --transport http dock ${url}/mcp
   In another harness, add an HTTP/streamable MCP server named "dock" at ${url}/mcp.
   The first call opens a browser consent (OAuth); the scope I grant maps to my Dock role.
2. Confirm it's connected by calling the "whoami" MCP tool, then "list_artifacts".

Once connected you can publish a page, read its review comments, and run the propose -> review -> revise loop — all over MCP.`

// Self-host: run Dock yourself first, then connect. Mirrors DEPLOY.md's single-
// container quickstart; the MCP endpoint is always <your BASE_URL>/mcp.
const selfHostPrompt = () =>
  `Set up a self-hosted Dock for me, then connect this agent to it. Dock is an open-source living-docs tool (permanent versioned URLs + inline review comments) that is itself a remote MCP server.

Please:
1. From a Dock checkout (the directory with deploy/Dockerfile), run the single-container image (state lives in the dock_data volume):
     docker build -f deploy/Dockerfile -t dock .
     docker run -d -p 8080:8080 -v dock_data:/data \\
       -e DOCK_AUTH_SECRET="$(openssl rand -hex 32)" \\
       -e BASE_URL="https://dock.example.com" \\
       dock
   Set BASE_URL to the public https URL I'll actually reach it at (behind a TLS proxy — not localhost). For a quick local-only trial, BASE_URL=http://localhost:8080 works.
2. Connect over MCP, using that same BASE_URL:
     claude mcp add --transport http dock <BASE_URL>/mcp
   The first call opens a browser consent (OAuth).
3. Confirm by calling the "whoami" MCP tool, then "list_artifacts".

Then you can publish, read review comments, and run the propose -> review -> revise loop over MCP.`

export function Welcome() {
  const { me, setMe } = useAuth()
  const nav = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  // Dev mode swaps the connect snippet for self-host / run-it-yourself instructions.
  const [devMode, setDevMode] = useState(false)

  const publicUrl = useMemo(
    () => (typeof window !== "undefined" ? publicUrlOf(window.location.origin) : PLACEHOLDER_URL),
    [],
  )
  const hostedText = useMemo(() => hostedPrompt(publicUrl), [publicUrl])
  const devText = useMemo(() => selfHostPrompt(), [])

  if (!me) return null

  const firstName = (me.name ?? me.username ?? me.email).split(/[@\s]/)[0]
  const initials = (me.name ?? me.email).slice(0, 2).toUpperCase()

  const pickPhoto = async (f: File | null) => {
    if (!f) return
    setUploading(true)
    try {
      const { image } = await api.uploadAvatar(f)
      setMe({ ...me, image })
    } catch {
      /* non-blocking */
    } finally {
      setUploading(false)
    }
  }

  const finish = () => {
    markOnboarded()
    nav({ to: "/" })
  }

  return (
    <div className="min-h-full overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-2xl px-5 py-10 sm:py-14">
        <div className="mb-6">
          <h1 className="font-display text-2xl font-semibold text-foreground sm:text-3xl">
            Welcome to Dock, {firstName}.
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            A minute of setup so your team and your agents know who you are. You can change any of
            this later in Settings.
          </p>
        </div>

        {/* 1 — Profile: photo + handle */}
        <Card className="p-5">
          <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Step 1 · You
          </div>
          <div className="mt-3 flex flex-wrap items-start gap-4">
            <div className="flex flex-col items-center gap-1">
              <button
                type="button"
                data-testid="welcome-avatar"
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
                {uploading ? "Uploading…" : me.image ? "Change" : "Add a photo"}
              </span>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                data-testid="welcome-avatar-input"
                className="hidden"
                onChange={(e) => pickPhoto(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="min-w-[240px] flex-1">
              <div className="mb-1 text-2xs font-medium text-muted-foreground">Username</div>
              <UsernameForm
                initial={me.username ?? ""}
                submitLabel={me.username ? "Update username" : "Save username"}
                onClaimed={(username) => setMe({ ...me, username })}
              />
              <p className="mt-2 text-2xs text-muted-foreground">
                <span className="font-medium text-foreground">{me.email}</span> stays private.
              </p>
            </div>
          </div>
        </Card>

        {/* 2 — Role + what you do */}
        <Card className="mt-4 p-5">
          <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Step 2 · Your role
          </div>
          <p className="mb-3 mt-1 text-sm text-muted-foreground">
            So teammates and agents know who they're working with.
          </p>
          <ProfileFields />
        </Card>

        {/* 3 — Connect your tools (paste-into-an-agent) */}
        <Card className="mt-4 p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              Step 3 · Connect your tools
            </div>
            {/* Compact Dev mode switch — swaps the snippet in place for the run-it-
                yourself path. Most people never touch it. */}
            <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-2xs font-medium text-muted-foreground">
              <span title="Self-hosting or running Dock locally">Dev mode</span>
              <button
                type="button"
                role="switch"
                aria-checked={devMode}
                aria-label="Dev mode (self-hosting)"
                data-testid="welcome-dev-toggle"
                onClick={() => setDevMode((v) => !v)}
                className={cn(
                  "flex h-[18px] w-8 items-center rounded-full p-[3px] transition-colors",
                  devMode ? "justify-end bg-primary" : "justify-start bg-foreground/15",
                )}
              >
                <span className="size-3 rounded-full bg-white shadow-sm" />
              </button>
            </label>
          </div>
          <p className="mb-3 mt-1 text-sm text-muted-foreground">
            {devMode
              ? "Spin up your own Dock, then connect your agent to it. Paste this into Claude Code, Codex, or any agent."
              : "Paste this into Claude Code, Codex, ChatGPT, or any agent — it connects Dock so the agent can publish, review, and revise for you."}
          </p>

          <PromptBlock
            key={devMode ? "dev" : "hosted"}
            text={devMode ? devText : hostedText}
            testid="welcome-prompt"
          />
        </Card>

        <div className="mt-6 flex items-center justify-between gap-3">
          <Button
            variant="ghost"
            data-testid="welcome-skip"
            className="text-muted-foreground"
            onClick={finish}
          >
            Skip for now
          </Button>
          <Button variant="primary" data-testid="welcome-continue" onClick={finish}>
            Continue to Dock
          </Button>
        </div>
      </div>
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
      <pre
        data-testid={testid}
        className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-secondary/40 p-3 pr-12 font-mono text-xs leading-relaxed text-foreground"
      >
        {text}
      </pre>
      <Button
        variant="outline"
        size="icon"
        data-testid={`${testid}-copy`}
        aria-label="Copy setup prompt"
        className="absolute right-2 top-2"
        onClick={copy}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
    </div>
  )
}

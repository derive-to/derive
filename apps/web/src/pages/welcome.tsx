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

// The paste-into-an-agent setup prompt. Dock is itself a remote MCP server, so the
// fastest on-ramp is to hand an agent (Claude Code, Codex, ChatGPT, …) one block of
// text and let it wire MCP + the CLI. The server origin is injected live.
const setupPrompt = (origin: string) =>
  `Set up Dock for me in this project. Dock is a living-docs tool: it hosts pages/docs at permanent, versioned URLs with inline review comments, and it's itself a remote MCP server.

Dock server: ${origin}
MCP endpoint: ${origin}/mcp  (remote, OAuth — the first call opens a browser consent; the scope I grant maps to my Dock role)

Please:
1. Connect over MCP. In Claude Code run:
     claude mcp add --transport http dock ${origin}/mcp
   In another harness, add an HTTP/streamable MCP server named "dock" at ${origin}/mcp.
2. Scaffold the project on-ramp (a Claude Code skill + .mcp.json) by running:
     npx -y @dock/cli init
   Set DOCK_SERVER=${origin}. (Until @dock/cli is published, run it from the Dock repo: node packages/cli/bin/dock.js init.)
3. Verify by calling the "whoami" MCP tool, then "list_artifacts".

Once connected you can publish a page, read its review comments, and run the propose -> review -> revise loop.`

export function Welcome() {
  const { me, setMe } = useAuth()
  const nav = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [copied, setCopied] = useState(false)

  const origin = useMemo(
    () => (typeof window !== "undefined" ? window.location.origin : "https://your-dock-server"),
    [],
  )
  const prompt = useMemo(() => setupPrompt(origin), [origin])

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

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
      toast.success("Copied — paste it into your agent")
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Couldn't copy; select the text and copy it manually")
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
          <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Step 3 · Connect your tools
          </div>
          <p className="mb-3 mt-1 text-sm text-muted-foreground">
            Paste this into Claude Code, Codex, ChatGPT, or any agent and it'll wire up Dock's MCP
            server and CLI for you.
          </p>
          <div className="relative">
            <pre
              data-testid="welcome-setup-prompt"
              className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-secondary/40 p-3 pr-12 font-mono text-xs leading-relaxed text-foreground"
            >
              {prompt}
            </pre>
            <Button
              variant="outline"
              size="icon"
              data-testid="welcome-copy"
              aria-label="Copy setup prompt"
              className="absolute right-2 top-2"
              onClick={copyPrompt}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </Button>
          </div>
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

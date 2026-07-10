import { Copy } from "lucide-react"
import { type ComponentProps, useState } from "react"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { toast } from "@/components/ui/sonner"
import { Switch } from "@/components/ui/switch"

// The one Connect-an-agent surface: the paste-into-your-agent prompt (hosted, with a
// self-host toggle), shared by onboarding Step 2, the library's connect empty state,
// and the Brandprint page's saved-but-inert nudge — extracted from welcome.tsx so
// every entry point renders the same thing. Rework's no-agent state (Phase 2) lands
// here too.

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

/**
 * The paste-into-your-agent block: a one-line description, the quiet self-host
 * toggle, and the copyable prompt. `testidPrefix` keys the block's testids
 * (`<prefix>-prompt`, `<prefix>-prompt-copy`, `<prefix>-dev-toggle`) so each entry
 * point stays individually addressable in e2e.
 */
export function ConnectAgent({ testidPrefix = "connect-agent" }: { testidPrefix?: string }) {
  // Self-host mode swaps the connect snippet for run-it-yourself instructions.
  const [devMode, setDevMode] = useState(false)
  const publicUrl =
    typeof window !== "undefined" ? publicUrlOf(window.location.origin) : PLACEHOLDER_URL
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-pretty text-muted-foreground">
        {devMode
          ? "Spin up your own Derive, then connect your agent to it. Paste this into Claude Code, Codex, or any agent."
          : "Paste this into Claude Code, Codex, ChatGPT, or any agent — it connects Derive so the agent can publish, review, and revise for you."}
      </p>
      {/* The self-host switch rides just above the snippet it swaps — a rarely-
          touched option, so it sits quiet and right-aligned, not in the header. */}
      <label className="flex items-center gap-1.5 self-end text-sm font-medium text-muted-foreground">
        <span>Self-host mode</span>
        <Switch
          checked={devMode}
          aria-label="Self-host mode"
          data-testid={`${testidPrefix}-dev-toggle`}
          onCheckedChange={setDevMode}
        />
      </label>
      <PromptBlock
        key={devMode ? "dev" : "hosted"}
        text={devMode ? selfHostPrompt() : hostedPrompt(publicUrl)}
        testid={`${testidPrefix}-prompt`}
      />
    </div>
  )
}

/**
 * A button that opens ConnectAgent in a dialog — for entry points that live far
 * from onboarding (the library's connect empty state, the Brandprint nudge).
 * Owns its open state so call sites stay one line.
 */
export function ConnectAgentButton({
  testId,
  children,
  ...props
}: ComponentProps<typeof Button> & { testId: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid={testId} {...props}>
          {children ?? "Connect an agent"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect an agent</DialogTitle>
          <DialogDescription>
            One paste connects any MCP agent to Derive — it can then publish, review, and revise for
            you.
          </DialogDescription>
        </DialogHeader>
        <ConnectAgent testidPrefix={`${testId}-dialog`} />
      </DialogContent>
    </Dialog>
  )
}

// A copyable prompt block: the scrollable text + a copy button that owns its own
// "copied" tick, so each block has independent state.
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

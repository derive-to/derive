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
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useCopy } from "@/lib/clipboard"

// The one Connect-an-agent surface: the paste-into-your-agent prompt (hosted, with a
// self-host toggle), shared by onboarding Step 2, the library's connect empty state,
// the Brandprint page's saved-but-inert nudge, and the Rework ⋯ item's no-agent
// state — extracted from welcome.tsx so every entry point renders the same thing.

// The public origin to hand an agent. A deployed Derive instance's own origin IS its
// public URL, so that's what we embed — except in local dev (localhost), where we
// fall back to a clearly-editable placeholder so nobody copies an unreachable URL.
const PLACEHOLDER_URL = "https://your-derive-server.com"
const publicUrlOf = (origin: string) =>
  /localhost|127\.0\.0\.1|\[::1\]/.test(origin) ? PLACEHOLDER_URL : origin
/** This instance's public origin, placeholder-substituted — for any copy an agent will
 *  paste (the connect prompt here, the Brandprint brief). */
export const publicUrl = () =>
  typeof window !== "undefined" ? publicUrlOf(window.location.origin) : PLACEHOLDER_URL

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
2. Confirm it's connected by calling the "find" MCP tool to list what's there (your identity, workspace, and role are already in the server instructions).

Once connected you can publish a page, read its review comments, and run the propose -> review -> revise loop — all over MCP.`

// Self-host: run Derive yourself first, then connect. Mirrors DEPLOY.md's single-
// container quickstart; the MCP endpoint is always <your BASE_URL>/mcp.
const selfHostPrompt = () =>
  `Set up a self-hosted Derive for me, then connect this agent to it. Derive is a Fair Source review-and-approval tool for agent-made work (durable versioned URLs + inline review comments) that is itself a remote MCP server.

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
3. Confirm by calling the "find" MCP tool to list what's there.

Then you can publish, read review comments, and run the propose -> review -> revise loop over MCP.`

/**
 * The connect surface: one tab per agent, each showing the lightest possible setup
 * for that harness — a single command where one exists, two short steps where it
 * doesn't. The full agent-native paste prompt (and the self-host variant) lives on
 * the "Any agent" tab so nobody is stranded. `testidPrefix` keys the block's
 * testids (`<prefix>-tab-<agent>`, `<prefix>-cmd-<agent>`, `<prefix>-prompt`,
 * `<prefix>-dev-toggle`) so each entry point stays individually addressable in e2e.
 */
export function ConnectAgent({ testidPrefix = "connect-agent" }: { testidPrefix?: string }) {
  const url = publicUrl()
  const mcp = `${url}/mcp`
  // Verified per-harness setup lines. Cursor reads .cursor/mcp.json; the others
  // register over their own CLI/UI. Kept inline (not a table) so each tab can
  // carry its own hint copy.
  const cursorJson = `{ "mcpServers": { "derive": { "url": "${mcp}" } } }`
  const consentHint = (
    <p className="text-sm text-pretty text-muted-foreground">
      The first call opens your browser once to approve — then it can publish, review, and revise
      for you.
    </p>
  )
  // Radix unmounts inactive TabsContent, so this is layout-only.
  const tabContent = "flex flex-col gap-2"
  return (
    <Tabs defaultValue="claude-code" className="gap-3">
      <TabsList size="sm" className="max-w-full overflow-x-auto">
        <TabsTrigger value="claude-code" data-testid={`${testidPrefix}-tab-claude-code`}>
          Claude Code
        </TabsTrigger>
        <TabsTrigger value="claude" data-testid={`${testidPrefix}-tab-claude`}>
          Claude
        </TabsTrigger>
        <TabsTrigger value="codex" data-testid={`${testidPrefix}-tab-codex`}>
          Codex
        </TabsTrigger>
        <TabsTrigger value="cursor" data-testid={`${testidPrefix}-tab-cursor`}>
          Cursor
        </TabsTrigger>
        <TabsTrigger value="any" data-testid={`${testidPrefix}-tab-any`}>
          Any agent
        </TabsTrigger>
      </TabsList>
      <TabsContent value="claude-code" className={tabContent}>
        <p className="text-sm text-pretty text-muted-foreground">
          One command, run anywhere — then tell it{" "}
          <span className="font-medium text-foreground">“connect to Derive.”</span>
        </p>
        <PromptBlock
          text={`claude mcp add --transport http derive ${mcp}`}
          testid={`${testidPrefix}-cmd-claude-code`}
          copyLabel="Copy command"
        />
        {consentHint}
      </TabsContent>
      <TabsContent value="claude" className={tabContent}>
        <p className="text-sm text-pretty text-muted-foreground">
          In claude.ai or Claude Desktop:{" "}
          <span className="font-medium text-foreground">
            Settings → Connectors → Add custom connector
          </span>
          , then paste this URL.
        </p>
        <PromptBlock text={mcp} testid={`${testidPrefix}-cmd-claude`} copyLabel="Copy URL" />
        {consentHint}
      </TabsContent>
      <TabsContent value="codex" className={tabContent}>
        <p className="text-sm text-pretty text-muted-foreground">One command connects Codex.</p>
        <PromptBlock
          text={`codex mcp add derive --url ${mcp}`}
          testid={`${testidPrefix}-cmd-codex`}
          copyLabel="Copy command"
        />
        {consentHint}
      </TabsContent>
      <TabsContent value="cursor" className={tabContent}>
        <p className="text-sm text-pretty text-muted-foreground">
          Add Derive to <span className="font-medium text-foreground">.cursor/mcp.json</span> (or
          Settings → MCP → Add server).
        </p>
        <PromptBlock
          text={cursorJson}
          testid={`${testidPrefix}-cmd-cursor`}
          copyLabel="Copy config"
        />
        {consentHint}
      </TabsContent>
      <TabsContent value="any" className={tabContent}>
        <AnyAgentPrompt testidPrefix={testidPrefix} url={url} />
      </TabsContent>
    </Tabs>
  )
}

// The pre-tabs connect block, now the "Any agent" fallback: the agent-native paste
// prompt with the quiet self-host toggle. Testids unchanged so every existing e2e
// entry point still resolves.
function AnyAgentPrompt({ testidPrefix, url }: { testidPrefix: string; url: string }) {
  // Self-host mode swaps the connect snippet for run-it-yourself instructions.
  const [devMode, setDevMode] = useState(false)
  return (
    <>
      <p className="text-sm text-pretty text-muted-foreground">
        {devMode
          ? "Spin up your own Derive, then connect your agent to it. Paste this into an MCP-capable agent."
          : "Paste this into any MCP-capable agent — it connects Derive so the agent can publish, review, and revise for you."}
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
        text={devMode ? selfHostPrompt() : hostedPrompt(url)}
        testid={`${testidPrefix}-prompt`}
      />
    </>
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
      <ConnectAgentDialogContent testidPrefix={`${testId}-dialog`} />
    </Dialog>
  )
}

/**
 * The dialog body every Connect-an-agent opening shares — one home for the header
 * copy, so the button-triggered and externally-controlled (Rework ⋯ menu) dialogs
 * can't drift apart. Render inside a `Dialog`.
 */
export function ConnectAgentDialogContent({ testidPrefix }: { testidPrefix: string }) {
  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Connect an agent</DialogTitle>
        <DialogDescription>
          Pick your agent — one command connects it to Derive, and it can then publish, review, and
          revise for you.
        </DialogDescription>
      </DialogHeader>
      <ConnectAgent testidPrefix={testidPrefix} />
    </DialogContent>
  )
}

// A copyable prompt block: the scrollable text + a copy button that owns its own
// "copied" tick, so each block has independent state. Shared with the Brandprint
// hand-off brief, so the copy UX can't drift between the two.
export function PromptBlock({
  text,
  testid,
  copyLabel = "Copy setup prompt",
}: {
  text: string
  testid: string
  copyLabel?: string
}) {
  const { copied, copy } = useCopy(2000)
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
        aria-label={copyLabel}
        className="absolute right-2 top-2"
        onClick={() => copy(text, { success: "Copied — paste it into your agent" })}
      >
        {copied ? <Icon name="check" className="text-success" /> : <Copy className="size-4" />}
      </Button>
    </div>
  )
}

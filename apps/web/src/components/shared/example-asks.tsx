import { useState } from "react"
import { Icon } from "@/components/icons"
import { toast } from "@/components/ui/sonner"

// The example first asks — the walkthrough IS these prompts: each teaches what
// Derive is for in the user's own tool. Shared by /welcome's connected state and
// the home library's connect nudge, so the suggested loop can't drift between them.
export const EXAMPLE_ASKS = [
  "Publish a one-page summary of what I'm working on to Derive.",
  "Turn the README into a shareable page on Derive.",
  "Draft our launch plan as a Derive doc I can get feedback on.",
]

// A copyable example ask — chip-shaped, mono-quoted, one tap to clipboard.
export function AskChip({ text, testId }: { text: string; testId: string }) {
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
    <button
      type="button"
      data-testid={testId}
      onClick={copy}
      className="flex items-center justify-between gap-3 rounded-lg border bg-secondary/40 px-4 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
    >
      <span className="text-pretty">"{text}"</span>
      <Icon
        name={copied ? "check" : "copy"}
        className={copied ? "shrink-0 text-success" : "shrink-0"}
      />
    </button>
  )
}

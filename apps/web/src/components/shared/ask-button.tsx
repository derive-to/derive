import { useShell } from "@/components/chrome/shell-context"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { useChatEnabled } from "@/lib/use-chat-enabled"

/**
 * ASK, beside a search box — the visible half of the gesture ⌘↵ performs.
 *
 * The library and the results page both already have a box you type into, so neither needs a
 * second one; what they need is a way to send what is in it to the agent instead of to the index.
 * Shared rather than written twice, because the two would drift on the one thing that matters: an
 * empty box opens the conversation, a full one asks the question in it, and both land in the same
 * place (the dock on a desktop, /chat on a phone — openAssistant decides, not this button).
 *
 * Renders nothing where chat is off, so a workspace that turned it off never sees an offer it
 * cannot take.
 */
export function AskButton({
  text,
  testId,
  className,
}: {
  /** Whatever is in the field right now. Empty is fine, and means "just open it". */
  text: string
  testId: string
  className?: string
}) {
  const { openAssistant } = useShell()
  const enabled = useChatEnabled()
  if (!enabled) return null
  const question = text.trim()
  return (
    <Button
      variant="outline"
      size="sm"
      className={className}
      data-testid={testId}
      // The label is one word and the state is in the tooltip, not in the label: a button whose
      // text changes as you type is a button people stop reading.
      title={question ? `Ask Derive about “${question}”` : "Ask Derive about your workspace"}
      aria-label={question ? `Ask Derive about ${question}` : "Ask Derive about your workspace"}
      onClick={() => openAssistant(question || undefined)}
    >
      <Icon name="sparkles" size={16} />
      Ask
    </Button>
  )
}

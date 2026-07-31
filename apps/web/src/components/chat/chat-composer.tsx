import type { ReactNode } from "react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

/** The box you type into, shared by every chat surface. Owns only the draft; sending, and what
 *  sending means, belong to the lane. */
export function ChatComposer(props: {
  onSend: (body: string) => Promise<void>
  placeholder: string
  disabled?: boolean
  /** Why chat cannot be used, when it cannot (no model configured, no permission). */
  disabledReason?: string
  /** Rendered on the row beside Send — the model picker, on surfaces that offer one. */
  accessory?: ReactNode
  className?: string
}) {
  const { onSend, placeholder, disabled, disabledReason, accessory, className } = props
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)

  const send = async () => {
    const body = draft.trim()
    if (!body || sending || disabled) return
    setSending(true)
    setDraft("")
    try {
      await onSend(body)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={cn("border-t border-border p-2.5", className)}>
      {disabled && disabledReason ? (
        <p className="px-1 pb-2 text-xs text-muted-foreground">{disabledReason}</p>
      ) : null}
      <div className="flex items-end gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter is a newline — the convention every chat surface
            // shares, and the one people's fingers already expect.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          disabled={disabled || sending}
          rows={2}
          placeholder={placeholder}
          // 16px on touch avoids iOS zoom-on-focus, matching the comment composer.
          className="max-h-40 min-h-[2.5rem] resize-none text-base sm:text-sm"
          data-testid="chat-input"
        />
        <div className="flex items-center gap-2">
          {accessory}
          <Button
            size="sm"
            onClick={() => void send()}
            disabled={disabled || sending || !draft.trim()}
            data-testid="chat-send"
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  )
}

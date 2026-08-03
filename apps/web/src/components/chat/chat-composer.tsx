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
  /**
   * A sentence to show above the box: why chat cannot be used (no model configured, no
   * permission), or why the last message did not send.
   *
   * It renders whenever there IS one. It used to render only while `disabled` was also true,
   * which meant the failure case — the composer is fine, the SEND failed — was silently dropped
   * on all three chat surfaces: the person's own message appeared, and then nothing, forever,
   * with the server's actual sentence ("no model is configured on this deploy") sitting unused in
   * state. A refusal you cannot see is indistinguishable from an agent ignoring you.
   */
  notice?: string
  /** Rendered on the row beside Send. */
  accessory?: ReactNode
  /** True while the agent owes a reply. With `onStop`, Send becomes Stop for the duration. */
  busy?: boolean
  /** Abandon the turn in flight. Absent, the surface simply offers no way out of a long answer. */
  onStop?: () => void
  /** Take focus on mount. The palette's answer view needs it: entering that view unmounts the
   *  command input the person was typing in, and focus left on a removed element falls to the
   *  body — so the next keystroke goes nowhere and a keyboard user is stranded mid-dialog. */
  autoFocus?: boolean
  className?: string
}) {
  const { onSend, placeholder, disabled, notice, accessory, busy, onStop, autoFocus, className } =
    props
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
      {/* Tone follows the state, with no second prop to keep in step: a DISABLED composer's
          notice explains a standing condition (quiet), while an enabled one's is something that
          just failed under the person's hand (loud enough to be read). */}
      {notice ? (
        <p
          role={disabled ? undefined : "alert"}
          data-testid="chat-composer-notice"
          className={cn(
            "px-1 pb-2 text-xs",
            disabled ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {notice}
        </p>
      ) : null}
      <div className="flex items-end gap-2">
        <Textarea
          // biome-ignore lint/a11y/noAutofocus: opt-in, and only where the view that just mounted took focus away from a control it unmounted.
          autoFocus={autoFocus}
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
          {/* STOP REPLACES SEND while a turn is in flight. Two buttons would ask a question
              nobody has — you cannot send while the agent still owes you an answer — and a long
              turn with no way out is the state that makes a slow answer feel like a broken app. */}
          {busy && onStop ? (
            <Button size="sm" variant="secondary" onClick={onStop} data-testid="chat-stop">
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void send()}
              disabled={disabled || sending || !draft.trim()}
              data-testid="chat-send"
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

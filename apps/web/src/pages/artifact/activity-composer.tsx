import { useEffect, useRef, useState } from "react"
import type { Mention } from "@/api"
import { Icon } from "@/components/icons"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { getInitials } from "@/lib/initials"
import { useActions } from "./comment-actions"
import { MentionField } from "./comment-composer"
import { quoteChipClass } from "./quote-chip"

/**
 * The rail's ONE input, docked at the bottom. What a message is attached to is a chip
 * above the field — the quoted selection, or the review round being answered — so the
 * rail never grows a second text box (the old review card carried its own). Enter
 * sends; when answering a round the same Enter sends the note back, and the secondary
 * "Send back" beside the field says so out loud.
 */
export function DockedComposer({
  quote,
  onClearQuote,
  answering,
  onStopAnswering,
  onSubmit,
  onSendBack,
  sendingBack,
  focusKey,
}: {
  /** The selection this comment will anchor to (a text quote or an element label). */
  quote: string | null
  onClearQuote: () => void
  /** The pending round the field is answering, when it is. */
  answering: { by: string | null; version: number } | null
  onStopAnswering: () => void
  onSubmit: (text: string, mentions: Mention[]) => void
  onSendBack: (note?: string) => void
  sendingBack: boolean
  /** Bump to focus the field (the header's New comment, a fresh selection). */
  focusKey: number
}) {
  const { meName } = useActions()
  const [text, setText] = useState("")
  const [mentions, setMentions] = useState<Mention[]>([])
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (focusKey === 0) return
    const el = wrap.current?.querySelector("textarea")
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [focusKey])

  const reset = () => {
    setText("")
    setMentions([])
  }
  const send = (resolved: Mention[]) => {
    if (answering) {
      onSendBack(text.trim() || undefined)
      reset()
      return
    }
    if (!text.trim()) return
    onSubmit(text, resolved)
    reset()
  }

  return (
    <div
      ref={wrap}
      data-testid="comment-composer"
      className="flex shrink-0 flex-col gap-1.5 border-t border-border px-2.5 pt-2 pb-2.5"
    >
      {answering && (
        <div className="flex items-center gap-1.5">
          <Badge variant="brand" className="min-w-0 flex-1 justify-start">
            <Icon name="review" size={12} />
            <span className="truncate">
              Answering {answering.by ? `${answering.by}'s` : "the"} review of v{answering.version}
            </span>
          </Badge>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                data-testid="review-answer-dismiss"
                aria-label="Comment instead"
                onClick={onStopAnswering}
              >
                <Icon name="close" className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Comment instead</TooltipContent>
          </Tooltip>
        </div>
      )}
      {quote && (
        <div className="flex items-center gap-1.5">
          <div className={quoteChipClass({ className: "min-w-0 flex-1 truncate" })}>“{quote}”</div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                data-testid="composer-cancel"
                aria-label="Remove the quote"
                onClick={onClearQuote}
              >
                <Icon name="close" className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Remove the quote</TooltipContent>
          </Tooltip>
        </div>
      )}
      <div className="flex items-end gap-2">
        {/* Your avatar leads the line, as it does on the thread reply row. */}
        <Avatar className="mb-1 size-5 shrink-0">
          <AvatarFallback className="text-2xs">{getInitials(meName)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <MentionField
            multiline
            testId={answering ? "review-send-note" : "composer-input"}
            sendTestId={answering ? undefined : "composer-submit"}
            className="field-sizing-content max-h-40 min-h-9"
            value={text}
            onChange={setText}
            mentions={mentions}
            onMentions={setMentions}
            onSubmit={send}
            onCancel={quote ? onClearQuote : answering ? onStopAnswering : undefined}
            placeholder={
              answering
                ? 'Answers, asks, or "good to go — ship it"'
                : quote
                  ? "Comment on the selection…"
                  : "Leave a comment…"
            }
          />
        </div>
      </div>
      <div className="flex items-center gap-2 pl-7">
        <span className="inline-flex select-none items-center gap-1 font-mono text-2xs text-muted-foreground max-sm:hidden">
          <Kbd>↵</Kbd> {answering ? "to send back" : "to send"}
          <span aria-hidden>·</span>
          <Kbd>@</Kbd> to mention
        </span>
        <span className="flex-1" />
        {answering && (
          <Button
            variant="secondary"
            size="sm"
            data-testid="review-send-back"
            loading={sendingBack}
            onClick={() => send(mentions)}
          >
            {sendingBack ? "Sending…" : "Send back"}
          </Button>
        )}
      </div>
    </div>
  )
}

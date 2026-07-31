import { ChatComposer } from "@/components/chat/chat-composer"
import { type ChatMessage, ChatThread } from "@/components/chat/chat-thread"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { cn } from "@/lib/utils"

// CHAT WITH THIS DOCUMENT — the right-rail sibling of the comments panel.
//
// Comments and chat are both "conversation about this document" and compete for the same
// rail, so they tab rather than stack. The difference that matters: a comment is anchored
// to a text range and a chat turn is not, so this panel never draws anchor highlights.
//
// The transcript is the source of truth, NOT the request: a turn is served detached, so
// closing the tab mid-turn loses nothing and this just re-polls. That is why there is no
// optimistic-only state here — the message appears once the server has it.
//
// The transcript rows, the streaming bubble and the composer are components/chat/*: this
// surface and the workspace chat page render the same conversation with a different subject,
// and the parts that must behave identically now only exist once.

export type { ChatMessage }

export function ArtifactChat(props: {
  messages: ChatMessage[]
  /** True while the agent owes a reply — drives the thinking row and the poll. */
  working: boolean
  /** The reply being written, when the gateway streams one. "" means nothing in flight, which
   *  is also what a non-streaming turn looks like — the panel falls back to the spinner. */
  streaming?: string
  disabled?: boolean
  /** Why chat cannot be used, when it cannot (no model configured, no permission). */
  disabledReason?: string
  onSend: (body: string) => Promise<void>
  onPoll: () => void
}) {
  const { messages, working, streaming, disabled, disabledReason, onSend, onPoll } = props
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="artifact-chat">
      <ChatThread
        messages={messages}
        working={working}
        streaming={streaming}
        onPoll={onPoll}
        className="px-3 py-3"
        empty={
          <EmptyState
            icon={<Icon name="sparkles" />}
            title="Chat with this document"
            description="Ask a question about it, or ask for a change. Edits land as a new version you can undo."
          />
        }
      />
      <ChatComposer
        onSend={onSend}
        disabled={disabled}
        disabledReason={disabledReason}
        placeholder="Ask about this doc, or ask for a change…"
      />
    </div>
  )
}

/** The rail's tab strip. Two tabs only, so this is a pair of buttons rather than a full
 *  Tabs primitive — it has to sit inline in the panel header the comments rail already owns. */
export function RailTabs(props: {
  tab: "comments" | "chat"
  commentCount: number
  onTab: (t: "comments" | "chat") => void
}) {
  const { tab, commentCount, onTab } = props
  return (
    <div className="flex items-center gap-1" data-testid="rail-tabs">
      {(["comments", "chat"] as const).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onTab(t)}
          aria-pressed={tab === t}
          className={cn(
            "rounded-md px-2 py-1 text-sm font-medium capitalize transition-colors",
            tab === t ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
          data-testid={`rail-tab-${t}`}
        >
          {t}
          {t === "comments" && commentCount > 0 ? (
            <span className="ml-1 text-xs text-muted-foreground">{commentCount}</span>
          ) : null}
        </button>
      ))}
    </div>
  )
}

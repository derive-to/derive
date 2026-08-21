import { useCallback } from "react"
import { json, useChatSession } from "@/components/chat/use-chat-session"

// The data half of the document chat rail: the shared session machine
// (components/chat/use-chat-session.ts), told how THIS lane opens a conversation.
//
// Opening is lazy — nothing is created until the first message, so merely looking at the Chat
// tab costs nothing and leaves no empty sessions lying around.

export function useArtifactChat(shortId: string) {
  // The first message opens the session, naming THIS document as the subject. What an edit
  // may do is the server's per-turn call — publish standing, the lock, and the workspace's
  // agent-write switch are all checked fresh when the turn runs, never stamped at open.
  const open = useCallback(
    (body: string) =>
      json<{ session: { id: string }; messages: unknown[] }>("/v1/artifacts/chat-session", {
        method: "POST",
        body: JSON.stringify({ short_id: shortId, body_md: body }),
      }),
    [shortId],
  )

  // The document is the subject, so navigating to another one abandons this conversation
  // rather than carrying its session id across — see the reset in the shared hook.
  const chat = useChatSession({ open, resetKey: shortId })

  return {
    messages: chat.messages,
    working: chat.working,
    streaming: chat.streaming,
    error: chat.error,
    send: chat.send,
    poll: chat.poll,
  }
}

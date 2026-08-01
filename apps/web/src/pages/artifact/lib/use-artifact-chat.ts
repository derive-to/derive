import { useCallback, useRef } from "react"
import { json, useChatSession } from "@/components/chat/use-chat-session"

// The data half of the document chat rail: the shared session machine
// (components/chat/use-chat-session.ts), told how THIS lane opens a conversation.
//
// Opening is lazy — nothing is created until the first message, so merely looking at the Chat
// tab costs nothing and leaves no empty sessions lying around.

export function useArtifactChat(shortId: string) {
  // Whether an edit may publish is decided at SEND time, not at mount: the caller computes it
  // from the live role and the lock state, both of which can change while the tab is open. A
  // ref rather than a hook argument keeps `send(body, canPublish)` exactly as the call site
  // already writes it, and keeps `open` stable so nothing re-subscribes per keystroke.
  const canPublish = useRef(false)

  // The first message opens the session, naming THIS document as the subject. `mode` is what
  // decides whether an edit publishes or proposes, and it follows what the person is actually
  // allowed to do — the server checks it again against real publish rights, so this is a
  // preference, never the gate.
  const open = useCallback(
    (body: string) =>
      json<{ session: { id: string }; messages: unknown[] }>("/v1/artifacts/chat-session", {
        method: "POST",
        body: JSON.stringify({
          short_id: shortId,
          body_md: body,
          mode: canPublish.current ? "publish" : "propose",
        }),
      }),
    [shortId],
  )

  // The document is the subject, so navigating to another one abandons this conversation
  // rather than carrying its session id across — see the reset in the shared hook.
  const chat = useChatSession({ open, resetKey: shortId })
  const send = useCallback(
    (body: string, publish: boolean) => {
      canPublish.current = publish
      return chat.send(body)
    },
    [chat.send],
  )

  return {
    messages: chat.messages,
    working: chat.working,
    streaming: chat.streaming,
    error: chat.error,
    send,
    poll: chat.poll,
  }
}

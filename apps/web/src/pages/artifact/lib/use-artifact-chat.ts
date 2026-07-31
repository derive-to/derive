import { useCallback, useEffect, useRef, useState } from "react"
import { useUserEvent } from "@/lib/use-user-events"
import type { ChatMessage } from "../artifact-chat"

// The data half of the chat rail. Deliberately plain fetch + local state rather than a query
// cache: a turn is served DETACHED, so the thing being modelled is "what does the transcript
// say right now", which is a poll, not a cache entry that something invalidates.
//
// Opening a session is lazy — nothing is created until the first message, so merely looking
// at the Chat tab costs nothing and leaves no empty sessions lying around.

interface SessionPayload {
  session: { id: string; state: string; subject: unknown } | null
  messages: ChatMessage[]
}

const json = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(url, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
  if (!r.ok) throw new Error(`${url} failed (${r.status})`)
  return (await r.json()) as T
}

export function useArtifactChat(shortId: string) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [state, setState] = useState<string>("answered")
  const [error, setError] = useState<string | null>(null)
  // The reply as it is being written, assembled from `session.delta`. Purely a VIEW: the server
  // persists nothing until the turn settles, and the transcript that then arrives replaces this.
  // Cleared the moment a real agent message lands, so the provisional text and the persisted
  // one can never both be on screen saying the same thing.
  const [streaming, setStreaming] = useState("")
  // Highest slice applied. Slices are ordered, but a reconnect can redeliver one — ignoring
  // anything not strictly newer makes that a no-op instead of duplicated text.
  const lastSeq = useRef(0)
  // Which model attempt the accumulated text belongs to (see the server note on `attempt`).
  const lastAttempt = useRef(0)

  const clearStream = useCallback(() => {
    setStreaming("")
    lastSeq.current = 0
    lastAttempt.current = 0
  }, [])

  const refresh = useCallback(
    async (id: string) => {
      try {
        const p = await json<SessionPayload>(`/v1/sessions/${id}`)
        const next = p.messages ?? []
        setMessages(next)
        setState(p.session?.state ?? "answered")
        // The persisted reply is here, so the provisional text has been superseded.
        if (next.some((m) => m.author_kind === "agent")) clearStream()
      } catch {
        /* a poll that misses is not worth surfacing — the next one covers it */
      }
    },
    [clearStream],
  )

  // Reset when the document changes. `shortId` MUST be in the deps: the route reuses this
  // component instance across /artifacts/$ref changes, so without it doc A's session id
  // survives a navigation to doc B — and the next message posts to a session whose subject
  // is still A. You would watch B on screen while A was edited. exhaustive-deps cannot catch
  // this, because the effect body references nothing from the closure.
  // shortId is a RESET TRIGGER, not a value the body reads, which is why the rule cannot see
  // that it is needed. Dropping it re-introduces the bug: the route reuses this component
  // across /artifacts/$ref changes, so doc A's session id survives to doc B and the next
  // message edits A.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset trigger, see above
  useEffect(() => {
    setSessionId(null)
    setMessages([])
    setError(null)
  }, [shortId])

  const send = useCallback(
    async (body: string, canPublish: boolean) => {
      setError(null)
      // Optimistic ONLY for the asker's own line: it is what the person just typed, so
      // showing it immediately is honest. The agent's reply is never faked.
      const optimistic: ChatMessage = {
        id: `local-${Date.now()}`,
        author_kind: "asker",
        body_md: body,
        created_at: new Date().toISOString(),
      }
      setMessages((m) => [...m, optimistic])
      setState("working")
      try {
        if (!sessionId) {
          // First message opens the session, naming THIS document as the subject. `mode`
          // is what decides whether an edit publishes or proposes, and it follows what the
          // person is actually allowed to do here.
          const created = await json<{ session: { id: string }; messages: ChatMessage[] }>(
            "/v1/artifacts/chat-session",
            {
              method: "POST",
              body: JSON.stringify({
                short_id: shortId,
                body_md: body,
                mode: canPublish ? "publish" : "propose",
              }),
            },
          )
          setSessionId(created.session.id)
          await refresh(created.session.id)
          return
        }
        await json(`/v1/sessions/${sessionId}/messages`, {
          method: "POST",
          body: JSON.stringify({ body_md: body }),
        })
        await refresh(sessionId)
      } catch (e) {
        setState("failed")
        setError(e instanceof Error ? e.message : "could not send")
      }
    },
    [sessionId, shortId, refresh],
  )

  const poll = useCallback(() => {
    if (sessionId) void refresh(sessionId)
  }, [sessionId, refresh])

  // `working` is the server's own view of whose turn it is, not a local flag that can desync —
  // a reload mid-turn still shows the spinner because the SESSION says working.
  const working = state === "working" || state === "open"
  // Subscribe only while a turn is actually in flight. That is also what tells the SERVER
  // somebody is watching: the first slice is published with a receipt, and a turn whose slice
  // reaches nobody stops publishing for the rest of the run.
  const live = !!sessionId && working

  useUserEvent(
    "session.delta",
    (e) => {
      let p: { session_id?: string; seq?: number; text?: string; attempt?: number }
      try {
        p = JSON.parse(e.data)
      } catch {
        return
      }
      if (p.session_id !== sessionId || typeof p.text !== "string") return
      const seq = typeof p.seq === "number" ? p.seq : lastSeq.current + 1
      if (seq <= lastSeq.current) return // a redelivery after a reconnect
      lastSeq.current = seq
      // A NEW ATTEMPT REPLACES, it does not append. The agent loop re-generates a reply that
      // missed its contract, and the abandoned attempt never reaches the transcript — appending
      // would show a garbled answer that the settled message then contradicts.
      const at = typeof p.attempt === "number" ? p.attempt : lastAttempt.current
      const fresh = at > lastAttempt.current
      lastAttempt.current = at
      const text = p.text
      setStreaming((s) => (fresh ? text : s + text))
    },
    live,
  )

  // The turn ended. Read the transcript NOW rather than waiting out the poll — this is the
  // event the whole streaming path builds to, and it is what swaps the provisional text for
  // the persisted reply.
  useUserEvent(
    "session.settled",
    (e) => {
      try {
        if ((JSON.parse(e.data) as { session_id?: string }).session_id !== sessionId) return
      } catch {
        return
      }
      if (sessionId) void refresh(sessionId)
    },
    live,
  )

  return {
    messages,
    working,
    /** The reply being written, or "" when there is nothing in flight. Render it as a
     *  provisional agent bubble; it is replaced by the real message when the turn settles. */
    streaming,
    error,
    send,
    poll,
  }
}

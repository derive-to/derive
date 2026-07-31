import { useCallback, useEffect, useRef, useState } from "react"
import { applyDelta, type DeltaState, EMPTY_DELTA, supersededBy } from "@/lib/session-delta"
import { usePageVisible } from "@/lib/use-page-visible"
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
  // The accumulation rules live in lib/session-delta.ts, shared with the context console so the
  // two surfaces cannot drift — they did, and one of them was wrong.
  const [delta, setDelta] = useState<DeltaState>(EMPTY_DELTA)
  // Agent rows seen so far, so a NEW one can be told from one that was already there.
  const agentCount = useRef(0)

  const clearStream = useCallback(() => setDelta(EMPTY_DELTA), [])

  const refresh = useCallback(
    async (id: string) => {
      try {
        const p = await json<SessionPayload>(`/v1/sessions/${id}`)
        const next = p.messages ?? []
        setMessages(next)
        setState(p.session?.state ?? "answered")
        // Clear on a NEW agent row, not on the existence of any. "Does this transcript contain
        // an agent message" is permanently true from turn two onward, so every poll during a
        // follow-up would wipe the reply mid-write and restart it from the next slice — the
        // bubble visibly resetting every few seconds. Turn one is unaffected, which is exactly
        // why hand-testing does not catch it.
        const agents = next.filter((m) => m.author_kind === "agent").length
        if (supersededBy(agents, agentCount.current)) clearStream()
        agentCount.current = agents
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
  // Subscribe only while a turn is actually in flight AND the tab is in front. Visibility is
  // not politeness: use-user-events' contract is that subscribers gate on it so a hidden tab
  // releases the per-user room Durable Object, and on this path it is also what makes the
  // server's no-listener shutoff work — a backgrounded tab that stays subscribed keeps
  // reporting a live reader, so the turn keeps paying to publish into a page nobody is looking
  // at. Every other useUserEvent caller in the app composes usePageVisible for the same reason.
  const visible = usePageVisible()
  const live = !!sessionId && working && visible

  useUserEvent("session.delta", (e) => setDelta((s) => applyDelta(s, e.data, sessionId)), live)

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
    streaming: delta.text,
    error,
    send,
    poll,
  }
}

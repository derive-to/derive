import { useCallback, useEffect, useRef, useState } from "react"
import { applyDelta, type DeltaState, EMPTY_DELTA, supersededBy } from "@/lib/session-delta"
import { usePageVisible } from "@/lib/use-page-visible"
import { useUserEvent } from "@/lib/use-user-events"
import type { ChatMessage } from "./chat-thread"

// THE STATE MACHINE BEHIND EVERY CHAT SURFACE: what the transcript says, whose turn it is, and
// the reply as it is being written.
//
// Deliberately plain fetch + local state rather than a query cache: a turn is served DETACHED,
// so the thing being modelled is "what does the transcript say right now", which is a poll, not
// a cache entry that something invalidates.
//
// What varies between surfaces is only how a conversation STARTS — the document rail names an
// artifact, the workspace chat names a workspace — so that is the one thing injected. Everything
// else (lazy open, follow-ups, the poll cadence, delta folding, the settle event, the reset on
// navigation) is identical, and was duplicated before this existed.

interface SessionPayload {
  session: { id: string; state: string } | null
  messages: ChatMessage[]
}

export const json = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(url, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
  if (!r.ok) {
    // The server's own sentence when it has one — "chat is not enabled for this workspace" is
    // worth reading, and a bare status code is not.
    //
    // `error` FIRST, because that is the API's actual contract: lib/http's `fail()` returns
    // `{ error: message }`, and this read only ever looked for `message`. So every refusal a
    // person could act on — chat not enabled, not a member, over budget, no model configured —
    // arrived here as "/v1/chat-session failed (503)". `message` stays as the fallback: a
    // handful of routes shape their bodies that way, and reading both costs nothing.
    const said = await r
      .clone()
      .json()
      .then((b: { error?: string; message?: string }) => b?.error || b?.message)
      .catch(() => null)
    throw new Error(said || `${url} failed (${r.status})`)
  }
  return (await r.json()) as T
}

export interface ChatSessionOptions {
  /** Start a conversation with this first message. The lane owns what that means. */
  open: (body: string) => Promise<{ session: { id: string } }>
  /** Continue one. Defaults to the shared follow-up route; a lane passes its own when the
   *  turn takes extra arguments (the workspace chat sends the chosen model). */
  followUp?: (sessionId: string, body: string) => Promise<unknown>
  /** Changing this ABANDONS the current conversation and starts empty — the document the rail
   *  is looking at, say. Not a value the hook reads; purely a reset trigger. */
  resetKey?: string
}

export function useChatSession(opts: ChatSessionOptions) {
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
  // The lane's callbacks, held in a ref so a caller may define them inline without every
  // keystroke re-subscribing the event listeners below.
  const lane = useRef(opts)
  lane.current = opts

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

  // Reset when the lane's subject changes. `resetKey` MUST be in the deps: a route reuses this
  // component instance across navigations, so without it document A's session id survives to
  // document B — and the next message posts to a session whose subject is still A. You would
  // watch B on screen while A was edited. exhaustive-deps cannot see this, because the effect
  // body references nothing from the closure: it is a reset TRIGGER, not a value.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset trigger, see above
  useEffect(() => {
    setSessionId(null)
    setMessages([])
    setError(null)
    setDelta(EMPTY_DELTA)
    agentCount.current = 0
  }, [opts.resetKey])

  /** Continue an EXISTING conversation (the history picker). Loads its transcript at once, so
   *  the surface never shows an empty thread for a session that has one. */
  const adopt = useCallback(
    async (id: string) => {
      setSessionId(id)
      setMessages([])
      setDelta(EMPTY_DELTA)
      agentCount.current = 0
      setError(null)
      await refresh(id)
    },
    [refresh],
  )

  /** Abandon this conversation and start a fresh one on the next message. */
  const reset = useCallback(() => {
    setSessionId(null)
    setMessages([])
    setDelta(EMPTY_DELTA)
    agentCount.current = 0
    setError(null)
    setState("answered")
  }, [])

  const send = useCallback(
    async (body: string) => {
      setError(null)
      // Optimistic ONLY for the asker's own line: it is what the person just typed, so showing
      // it immediately is honest. The agent's reply is never faked.
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
          // The first message OPENS the session, so merely looking at a chat surface creates
          // nothing and leaves no empty sessions lying around.
          const created = await lane.current.open(body)
          setSessionId(created.session.id)
          await refresh(created.session.id)
          return
        }
        const followUp =
          lane.current.followUp ??
          ((id: string, text: string) =>
            json(`/v1/sessions/${id}/messages`, {
              method: "POST",
              body: JSON.stringify({ body_md: text }),
            }))
        await followUp(sessionId, body)
        await refresh(sessionId)
      } catch (e) {
        setState("failed")
        setError(e instanceof Error ? e.message : "could not send")
      }
    },
    [sessionId, refresh],
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
    sessionId,
    messages,
    working,
    /** The reply being written, or "" when there is nothing in flight. Render it as a
     *  provisional agent bubble; it is replaced by the real message when the turn settles. */
    streaming: delta.text,
    error,
    send,
    poll,
    adopt,
    reset,
  }
}

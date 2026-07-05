import type { Dispatch, SetStateAction } from "react"
import { useEffect, useRef } from "react"
import { ApiError, type Artifact, type Comment } from "@/api"
import { refFor } from "./parse-ref"
import type { Panel } from "./types"

/**
 * The artifact page's three URL/routing side-effects, lifted out of the page so it
 * keeps only view state:
 *  - canonicalise the URL to /artifacts/<name>-<shortId> once the artifact loads
 *    (preserving the @vN suffix + current search), so the browser holds the readable ref;
 *  - bounce a logged-out visitor to /login ONLY on a genuine 404/403 gate — never on a
 *    transient 5xx/network failure (which also nulls `me`), so an outage doesn't eject them;
 *  - honour a ?comment=<thread> deep link once comments arrive (open the panel, activate
 *    the thread, scroll to its highlight), exactly once.
 *
 * `nav` stays in the page: the two navigations are passed in as `onCanonical`/
 * `onLoginBounce` so this hook is router-type-free (matching artifact-actions).
 */
export function useArtifactRoute(p: {
  art: Artifact | undefined
  ref: string
  shortId: string
  version: number | undefined
  comments: Comment[]
  /** !!me — a signed-in viewer. */
  authed: boolean
  loading: boolean
  failed: boolean
  locked: boolean
  error: unknown
  onCanonical: (canonicalRef: string) => void
  onLoginBounce: () => void
  post: (msg: Record<string, unknown>) => void
  setPanel: Dispatch<SetStateAction<Panel>>
  setActiveThread: Dispatch<SetStateAction<string | null>>
}) {
  const { art, ref, shortId, version, comments, authed, loading, failed, locked, error } = p
  const { onCanonical, onLoginBounce, post, setPanel, setActiveThread } = p

  // Canonicalise the URL client-side: rewrite any non-canonical ref (bare id, stale
  // name, legacy order) to /artifacts/<name>-<shortId>. Idempotent — once the ref
  // matches, this no-ops, so it never loops.
  useEffect(() => {
    if (!art || art.removed) return
    const canonical = version
      ? `${refFor({ short_id: shortId, title: art.title })}@v${version}`
      : refFor({ short_id: shortId, title: art.title })
    if (ref !== canonical) onCanonical(canonical)
  }, [art, ref, version, shortId, onCanonical])

  // Anonymous can view a public artifact (read-only, with a sign-up CTA). Bounce to
  // login ONLY when the artifact is genuinely gated (404/403) for a logged-out visitor.
  // A TRANSIENT failure (5xx/network) also nulls `me`, but must NOT eject the user
  // mid-outage — the recoverable error state handles that.
  useEffect(() => {
    const gated = error instanceof ApiError && (error.status === 404 || error.status === 403)
    if (!loading && !authed && failed && !locked && gated) onLoginBounce()
  }, [loading, authed, failed, locked, error, onLoginBounce])

  // Deep link: ?comment=<thread> opens the panel, activates that thread, and jumps to
  // its text. Runs once, after comments are in.
  const deepLinked = useRef(false)
  useEffect(() => {
    if (deepLinked.current || comments.length === 0) return
    deepLinked.current = true
    const cid = new URLSearchParams(window.location.search).get("comment")
    const target = cid ? comments.find((c) => c.thread_id === cid) : undefined
    if (target) {
      setPanel("open")
      setActiveThread(target.thread_id)
      setTimeout(() => post({ type: "focus-anchor", id: target.thread_id }), 320)
    }
  }, [comments, post, setPanel, setActiveThread])
}

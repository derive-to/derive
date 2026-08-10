import type { Dispatch, SetStateAction } from "react"
import { useEffect, useRef } from "react"
import type { Artifact, Comment } from "@/api"
import { refFor } from "./parse-ref"
import type { Panel } from "./types"

/**
 * The artifact page's three URL/routing side-effects, lifted out of the page so it
 * keeps only view state:
 *  - canonicalise the URL to /artifacts/<name>-<shortId> once the artifact loads
 *    (preserving the @vN suffix + current search), so the browser holds the readable ref;
 *  - honour a ?comment=<thread> deep link once comments arrive (open the panel, activate
 *    the thread, scroll to its highlight), exactly once;
 *  - honour a ?review=<proposal> deep link once the artifact loads (open the review
 *    overlay on that proposal), exactly once.
 *
 * A gated (404/403) read no longer auto-bounces to /login — the page renders
 * ArtifactNotFound with an optional Sign-in CTA (return path) so missing and private
 * stay indistinguishable and signed-out visitors still have a path forward.
 *
 * `nav` stays in the page: the navigations are passed in as `onCanonical` so this
 * hook is router-type-free (matching artifact-actions).
 */
export function useArtifactRoute(p: {
  art: Artifact | undefined
  ref: string
  shortId: string
  version: number | undefined
  comments: Comment[]
  /** !!me — a signed-in viewer. */
  authed: boolean
  onCanonical: (canonicalRef: string) => void
  /** Open the proposal-review overlay on a specific proposal (the ?review deep link). */
  onOpenReview: (proposalId: string) => void
  post: (msg: Record<string, unknown>) => void
  setPanel: Dispatch<SetStateAction<Panel>>
  setActiveThread: Dispatch<SetStateAction<string | null>>
}) {
  const { art, ref, shortId, version, comments, authed } = p
  const { onCanonical, onOpenReview, post, setPanel, setActiveThread } = p

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

  // Deep link: ?review=<proposal> opens the review overlay on that proposal. Runs once,
  // after the artifact is in — the overlay owns loading and the role-appropriate view,
  // so this only names the target. Signed-in viewers only (proposals are account-gated).
  const reviewLinked = useRef(false)
  useEffect(() => {
    if (reviewLinked.current || !art || art.removed || !authed) return
    reviewLinked.current = true
    const proposalId = new URLSearchParams(window.location.search).get("review")
    if (proposalId) onOpenReview(proposalId)
  }, [art, authed, onOpenReview])

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

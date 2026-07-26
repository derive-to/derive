import { useEffect, useState } from "react"
import { api, type Diff } from "@/api"

/**
 * The version view: whether we're showing the rendered preview or a line diff,
 * plus the fetched diff. Switching artifact/version snaps back to preview;
 * entering diff mode on a past version fetches "what changed since this version"
 * against current. The page reads `view`/`diff` and flips `setView`.
 */
export function useVersionDiff(
  art: { current_version: number } | undefined,
  shortId: string,
  version: number | undefined,
) {
  const [view, setView] = useState<"preview" | "diff">("preview")
  const [diff, setDiff] = useState<Diff | null>(null)
  // A failed diff fetch must not leave DiffView spinning forever; track it so the
  // view can show an error + retry. `nonce` lets retry re-run the effect.
  const [failed, setFailed] = useState(false)
  const [nonce, setNonce] = useState(0)

  // Switching versions returns to the rendered preview.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets the view on a version/artifact change.
  useEffect(() => setView("preview"), [version, shortId])

  // In history mode, "show changes" diffs the version being viewed against the
  // current one — what's changed since this older version.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is an intentional re-trigger so `retry()` re-runs the fetch; its value isn't read in the body.
  useEffect(() => {
    if (view !== "diff" || !art) return
    const shownN = version ?? art.current_version
    if (shownN >= art.current_version) {
      setDiff(null)
      setFailed(false)
      return
    }
    setDiff(null)
    setFailed(false)
    let alive = true
    api
      .diff(shortId, shownN, art.current_version)
      .then((d) => alive && setDiff(d))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [view, version, art, shortId, nonce])

  return { view, setView, diff, failed, retry: () => setNonce((n) => n + 1) }
}

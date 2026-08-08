import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "@/components/ui/sonner"

/**
 * THE clipboard write. Every copy affordance goes through here so the contract
 * can't drift: the write is AWAITED, and the success toast fires only after it
 * lands. (The hand-rolled copies this replaced included fire-and-forget
 * `navigator.clipboard?.writeText(x)` immediately followed by "Token copied" —
 * in an insecure context the optional chain no-ops and the toast lies about a
 * secret being on the clipboard.)
 *
 * `success` is opt-in (some affordances show a ✓ tick instead of a toast).
 * `error: null` suppresses the failure toast for callers with their own
 * fallback (e.g. toasting the raw URL so it can be copied by hand); the boolean
 * return is how they know to run it.
 */
export async function copyText(
  text: string,
  opts: { success?: string; error?: string | null } = {},
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    if (opts.success) toast.success(opts.success)
    return true
  } catch {
    if (opts.error !== null)
      // A clipboard write is not an API mutation; this is the copy affordance's own failure toast.
      toast.error(opts.error ?? "Couldn't copy — select the text and copy it manually.") // mutation-ignore
    return false
  }
}

/** `copyText` plus the transient ✓ state: `copied` holds true for `ms` after a
 *  successful copy (re-copying restarts the window; unmount clears the timer). */
export function useCopy(ms = 1500): {
  copied: boolean
  copy: (text: string, opts?: { success?: string; error?: string | null }) => Promise<boolean>
} {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = useCallback(
    async (text: string, opts?: { success?: string; error?: string | null }) => {
      const ok = await copyText(text, opts)
      if (ok) {
        setCopied(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), ms)
      }
      return ok
    },
    [ms],
  )
  return { copied, copy }
}

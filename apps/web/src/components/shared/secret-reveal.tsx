import type { ReactNode } from "react"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { copyText } from "@/lib/clipboard"

// The one-time secret moment: an agent bearer, a runner token, a 2FA setup key,
// a set of backup codes — shown exactly once, in the safety-orange warning
// register (never the accent), with Copy and Done. One component so the moment
// can't drift: the same panel, the same code register, the same action pair
// everywhere a credential is revealed.
export function SecretReveal({
  title,
  secret,
  onDone,
  copySuccess = "Token copied",
  copyLabel = "Copy",
  downloadName,
  downloadTestId,
  copyTestId,
  doneTestId,
  secretTestId,
}: {
  title: ReactNode
  /** The credential. An array (backup codes) renders as a two-column grid. */
  secret: string | string[]
  /** Omit when a surrounding flow (a dialog step) owns the dismissal. */
  onDone?: () => void
  copySuccess?: string
  copyLabel?: string
  /** Offer a Download button saving the secret as this filename. */
  downloadName?: string
  downloadTestId?: string
  copyTestId?: string
  doneTestId?: string
  secretTestId?: string
}) {
  const text = Array.isArray(secret) ? secret.join("\n") : secret
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain" }))
    const a = document.createElement("a")
    a.href = url
    a.download = downloadName ?? "secret.txt"
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <StatusPanel
      tone="warning"
      layout="inline"
      title={title}
      description={
        Array.isArray(secret) ? (
          <div
            data-testid={secretTestId}
            className="grid grid-cols-2 gap-1 rounded-md bg-secondary px-2.5 py-2 font-mono text-2xs text-foreground"
          >
            {secret.map((s) => (
              <span key={s}>{s}</span>
            ))}
          </div>
        ) : (
          <code
            data-testid={secretTestId}
            className="block break-all rounded-md bg-secondary px-2.5 py-1.5 font-mono text-2xs text-foreground"
          >
            {secret}
          </code>
        )
      }
      action={
        <div className="flex items-center gap-2">
          {/* type="button" throughout: a reveal often renders inside a form (the 2FA
              enable dialog), and a bare Button would implicitly submit it. */}
          <Button
            type="button"
            data-testid={copyTestId}
            variant="secondary"
            size="sm"
            onClick={() => void copyText(text, { success: copySuccess })}
          >
            {copyLabel}
          </Button>
          {downloadName && (
            <Button
              type="button"
              data-testid={downloadTestId}
              variant="ghost"
              size="sm"
              onClick={download}
            >
              Download
            </Button>
          )}
          {onDone && (
            <Button
              type="button"
              data-testid={doneTestId}
              variant="ghost"
              size="sm"
              onClick={onDone}
            >
              Done
            </Button>
          )}
        </div>
      }
    />
  )
}

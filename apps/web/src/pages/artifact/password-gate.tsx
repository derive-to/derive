import { Lock } from "lucide-react"
import { type FormEvent, useState } from "react"
import { api } from "@/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/**
 * Shown when an artifact is `password` visibility and the visitor hasn't unlocked
 * it yet (getArtifact returned 401). On success the server sets the unlock cookie;
 * `onUnlocked` refetches so the real artifact view renders.
 */
export function PasswordGate({ shortId, onUnlocked }: { shortId: string; onUnlocked: () => void }) {
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!password) return
    setBusy(true)
    setErr(null)
    try {
      await api.unlock(shortId, password)
      onUnlocked()
    } catch {
      setErr("That password didn't work.")
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4">
      <form
        onSubmit={submit}
        className="flex w-full max-w-xs flex-col gap-4 rounded-xl border border-border bg-card p-6 text-center shadow-[var(--shadow)]"
      >
        <div className="flex flex-col items-center gap-3">
          <Lock className="size-6 text-muted-foreground" strokeWidth={1.75} aria-hidden />
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold text-balance">
              This artifact is password-protected
            </h1>
            <p className="text-sm text-pretty text-muted-foreground">
              Enter the password to view it.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Input
            type="password"
            name="password"
            autoComplete="current-password"
            autoFocus
            data-testid="password-gate-input"
            placeholder="Password"
            aria-label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {err && (
            <p data-testid="password-gate-error" role="alert" className="text-sm text-destructive">
              {err}
            </p>
          )}
        </div>
        <Button
          type="submit"
          variant="default"
          data-testid="password-gate-submit"
          disabled={busy || !password}
          className="w-full"
        >
          {busy ? "Unlocking…" : "Unlock"}
        </Button>
      </form>
    </div>
  )
}

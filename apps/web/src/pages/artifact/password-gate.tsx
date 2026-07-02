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
        className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-center shadow-[var(--shadow)]"
      >
        <div className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
          <Lock className="size-5" />
        </div>
        <h1 className="text-lg font-semibold">This artifact is password-protected</h1>
        <p className="mt-1 text-sm text-muted-foreground">Enter the password to view it.</p>
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
          className="mt-4"
        />
        {err && (
          <p
            data-testid="password-gate-error"
            role="alert"
            className="mt-2 text-xs text-destructive"
          >
            {err}
          </p>
        )}
        <Button
          type="submit"
          variant="default"
          data-testid="password-gate-submit"
          disabled={busy || !password}
          className="mt-3 w-full"
        >
          {busy ? "Unlocking…" : "Unlock"}
        </Button>
      </form>
    </div>
  )
}

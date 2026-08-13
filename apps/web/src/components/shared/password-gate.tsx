import { type FormEvent, useState } from "react"
import { Icon } from "@/components/icons"
import { fieldError } from "@/components/shared/field-error"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/** The one password-link gate for every shareable subject. The caller supplies only
 *  the noun and unlock request; validation, accessibility, feedback, and visual
 *  treatment cannot drift between artifacts and collections. */
export function PasswordGate({
  subject,
  unlock,
  onUnlocked,
}: {
  subject: "artifact" | "collection"
  unlock: (password: string) => Promise<unknown>
  onUnlocked: () => void
}) {
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const errField = fieldError("password-gate-error", err)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!password) return
    setBusy(true)
    setErr(null)
    try {
      await unlock(password)
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
          <Icon name="lock" size={24} strokeWidth={1.75} className="text-muted-foreground" />
          <div className="flex flex-col gap-1">
            <h1 className="font-serif text-xl font-medium tracking-tight text-balance">
              This {subject} is password-protected
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
            {...errField.aria}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              setErr(null)
            }}
          />
          {errField.node}
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

import { type FormEvent, useEffect, useRef, useState } from "react"
import { ApiError, api } from "@/api"
import { Button } from "@/components/ui/button"
import { usernameError } from "@/lib/username"
import { cn } from "@/lib/utils"

// The claim/rename handle form, shared by the onboarding gate and the profile
// page's self-edit. Live client validation mirrors the server (lib/username);
// the server stays authoritative and its 409/400 message surfaces inline.
export function UsernameForm({
  initial = "",
  submitLabel,
  onClaimed,
}: {
  initial?: string
  submitLabel: string
  onClaimed: (username: string) => void
}) {
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [serverErr, setServerErr] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  // Focus the field on mount — it's the only input on the onboarding screen, and
  // the sole action when renaming inline (a ref instead of autoFocus per a11y).
  useEffect(() => inputRef.current?.focus(), [])
  const handle = value.trim().toLowerCase()
  const localErr = handle ? usernameError(handle) : null
  const err = serverErr || (handle ? localErr : null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (localErr || !handle) return
    setBusy(true)
    setServerErr("")
    try {
      const { username } = await api.setUsername(handle)
      onClaimed(username)
    } catch (caught) {
      setServerErr(caught instanceof ApiError ? caught.message : "Could not save your username.")
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5">
      <div
        className={cn(
          "flex items-center rounded-md border border-input bg-card transition-colors",
          "focus-within:border-primary focus-within:ring-2 focus-within:ring-accent",
          err && "border-destructive",
        )}
      >
        <span className="select-none pl-3 text-sm font-medium text-muted-foreground">@</span>
        <input
          ref={inputRef}
          data-testid="username-input"
          aria-label="Username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setServerErr("")
          }}
          placeholder="yourname"
          className="h-9 w-full rounded-md bg-transparent pl-1 pr-3 text-base text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      {err && (
        <p data-testid="username-error" role="alert" className="text-xs text-destructive">
          {err}
        </p>
      )}
      <Button
        data-testid="username-submit"
        type="submit"
        variant="primary"
        size="lg"
        disabled={busy || !handle || !!localErr}
        className="w-full"
      >
        {busy ? "…" : submitLabel}
      </Button>
    </form>
  )
}

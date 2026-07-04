import { type FormEvent, useEffect, useRef, useState } from "react"
import { ApiError, api } from "@/api"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import { normalizeUsername, usernameError } from "@/lib/username"

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
  const handle = normalizeUsername(value)
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
    <form onSubmit={submit} className="flex flex-col items-start gap-2">
      <InputGroup>
        <InputGroupAddon>
          <InputGroupText>@</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          data-testid="username-input"
          aria-label="Username"
          aria-invalid={!!err}
          aria-describedby={err ? "username-error" : undefined}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setServerErr("")
          }}
          placeholder="yourname"
        />
      </InputGroup>
      {err && (
        <p
          id="username-error"
          data-testid="username-error"
          role="alert"
          className="text-sm text-destructive"
        >
          {err}
        </p>
      )}
      <Button
        data-testid="username-submit"
        type="submit"
        variant="secondary"
        size="sm"
        loading={busy}
        disabled={!handle || !!localErr}
      >
        {busy ? "Saving…" : submitLabel}
      </Button>
    </form>
  )
}

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { ApiError, type AuthCapabilities, api } from "@/api"
import { EmptyState } from "@/components/shared/empty-state"
import { FormField } from "@/components/shared/form-field"
import { SettingRow } from "@/components/shared/setting-row"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { toast } from "@/components/ui/sonner"
import { useAuth } from "@/ctx"
import { authClient } from "@/lib/auth-client"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

// Account security — the home for the credentials that protect your account (and, since a
// human's factor is the root of trust the agent-delegation chain hangs from, a first-class
// surface). This phase: password + email/verification. Passkeys, active sessions, connected
// accounts, 2FA, and delete-account land here in later phases.
export function SecuritySection() {
  const { me } = useAuth()
  // What flows this instance actually supports (change-password/email only make sense where
  // mail can deliver the confirmations). Null while loading.
  const [caps, setCaps] = useState<AuthCapabilities | null>(null)
  useEffect(() => {
    api
      .capabilities()
      .then(setCaps)
      .catch(() => setCaps(null))
  }, [])
  if (!me) return null

  return (
    <SettingsSection
      title="Security"
      description="The credentials that protect your account. Your email address always stays private."
    >
      <SettingsGroup>
        <PasswordRow />
        <EmailRow email={me.email} verified={me.emailVerified} canChange={!!caps?.passwordReset} />
      </SettingsGroup>

      {caps?.passkey && <Passkeys />}
      <TwoFactor />
      <Sessions />
    </SettingsSection>
  )
}

// TOTP two-factor: enable (password → scan/enter the secret → confirm a code → save backup
// codes) or disable (password). Zero external dependency — codes come from an authenticator
// app. A passkey sign-in is already phishing-resistant, so this is opt-in on top.
function TwoFactor() {
  const { me, setMe } = useAuth()
  const enabled = !!me?.twoFactorEnabled
  const refresh = async () => setMe(await api.session())
  return (
    <SettingsGroup>
      <SettingRow
        label={
          <span className="flex items-center gap-2">
            Two-factor authentication
            {enabled ? <Badge variant="secondary">On</Badge> : <Badge variant="outline">Off</Badge>}
          </span>
        }
        description="A one-time code from your authenticator app, asked for at sign-in."
      >
        {enabled ? <DisableTwoFactor onDone={refresh} /> : <EnableTwoFactor onDone={refresh} />}
      </SettingRow>
    </SettingsGroup>
  )
}

function EnableTwoFactor({ onDone }: { onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<"password" | "confirm">("password")
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [secret, setSecret] = useState("")
  const [backup, setBackup] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")

  const reset = () => {
    setStep("password")
    setPassword("")
    setCode("")
    setSecret("")
    setBackup([])
    setErr("")
  }

  const start = async () => {
    setErr("")
    setBusy(true)
    try {
      const res = await authClient.twoFactor.enable({ password })
      if (res?.error || !res?.data) throw new Error(res?.error?.message ?? "Could not start setup.")
      // totpURI is otpauth://totp/Derive:email?secret=…&issuer=Derive — pull the manual key.
      setSecret(new URL(res.data.totpURI).searchParams.get("secret") ?? "")
      setBackup(res.data.backupCodes ?? [])
      setStep("confirm")
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    setErr("")
    setBusy(true)
    try {
      const res = await authClient.twoFactor.verifyTotp({ code })
      if (res?.error) throw new Error(res.error.message ?? "That code didn't work.")
      await onDone()
      toast.success("Two-factor authentication is on")
      setOpen(false)
      reset()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="2fa-enable">
          Enable
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enable two-factor authentication</DialogTitle>
          <DialogDescription>
            {step === "password"
              ? "Confirm your password to begin."
              : "Add the key to your authenticator app, save your backup codes, then confirm a code."}
          </DialogDescription>
        </DialogHeader>
        {err && <StatusPanel tone="danger" layout="inline" title={err} />}
        {step === "password" ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              start()
            }}
          >
            <FormField label="Password" htmlFor="tfa-password">
              <Input
                id="tfa-password"
                data-testid="2fa-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </FormField>
            <DialogFooter>
              <Button type="submit" loading={busy} disabled={!password} data-testid="2fa-start">
                {busy ? "Starting…" : "Continue"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              confirm()
            }}
          >
            <div className="flex flex-col gap-1.5">
              <div className="text-sm font-medium text-foreground">Setup key</div>
              <code
                data-testid="2fa-secret"
                className="block break-all rounded-md bg-secondary px-2.5 py-1.5 font-mono text-2xs text-foreground"
              >
                {secret}
              </code>
            </div>
            {backup.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <div className="text-sm font-medium text-foreground">
                  Backup codes — save these somewhere safe
                </div>
                <div
                  data-testid="2fa-backup-codes"
                  className="grid grid-cols-2 gap-1 rounded-md bg-secondary px-2.5 py-2 font-mono text-2xs text-foreground"
                >
                  {backup.map((c) => (
                    <span key={c}>{c}</span>
                  ))}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  data-testid="2fa-copy-backup"
                  onClick={() => {
                    navigator.clipboard?.writeText(backup.join("\n"))
                    toast.success("Backup codes copied")
                  }}
                >
                  Copy codes
                </Button>
              </div>
            )}
            <FormField label="Confirm a code from your app" htmlFor="tfa-code">
              <Input
                id="tfa-code"
                data-testid="2fa-confirm-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
              />
            </FormField>
            <DialogFooter>
              <Button type="submit" loading={busy} disabled={!code} data-testid="2fa-confirm">
                {busy ? "Verifying…" : "Turn on"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function DisableTwoFactor({ onDone }: { onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")

  const submit = async () => {
    setErr("")
    setBusy(true)
    try {
      const res = await authClient.twoFactor.disable({ password })
      if (res?.error) throw new Error(res.error.message ?? "Could not turn it off.")
      await onDone()
      toast.success("Two-factor authentication is off")
      setOpen(false)
      setPassword("")
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="2fa-disable">
          Turn off
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Turn off two-factor authentication</DialogTitle>
          <DialogDescription>
            Confirm your password. Your account will be less protected.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          {err && <StatusPanel tone="danger" layout="inline" title={err} />}
          <FormField label="Password" htmlFor="tfa-off-password">
            <Input
              id="tfa-off-password"
              data-testid="2fa-off-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </FormField>
          <DialogFooter>
            <Button
              type="submit"
              variant="destructive"
              loading={busy}
              disabled={!password}
              data-testid="2fa-off-confirm"
            >
              {busy ? "Turning off…" : "Turn off"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// Active sessions across the user's devices, with a one-tap "sign out everywhere else" —
// the standard account-security control for a lost/shared device. Individual devices aren't
// named (Better Auth stores only UA + IP), so we show a coarse device line and the headline
// bulk action rather than a per-row revoke that's hard to attribute confidently.
function Sessions() {
  const qc = useQueryClient()
  const { data: sessions, isPending } = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => (await authClient.listSessions()).data ?? [],
  })
  const [revoking, setRevoking] = useState(false)

  const revokeOthers = async () => {
    setRevoking(true)
    try {
      await authClient.revokeOtherSessions()
      toast.success("Signed out your other devices")
      qc.invalidateQueries({ queryKey: ["sessions"] })
    } catch {
      toast.error("Could not sign out the other sessions")
    } finally {
      setRevoking(false)
    }
  }

  const count = sessions?.length ?? 0
  return (
    <SettingsGroup>
      <SettingRow
        label="Active sessions"
        description={
          isPending
            ? "Loading your signed-in devices…"
            : count <= 1
              ? "You're signed in on this device only."
              : `You're signed in on ${count} devices.`
        }
      >
        <Button
          variant="outline"
          size="sm"
          onClick={revokeOthers}
          loading={revoking}
          disabled={count <= 1}
          data-testid="sessions-revoke-others"
        >
          Sign out other devices
        </Button>
      </SettingRow>
    </SettingsGroup>
  )
}

// Passkeys (WebAuthn) — the phishing-resistant, passwordless factor. List, add, and remove
// them here; adding one runs the browser's create-credential ceremony via the auth client.
// This is the human root of trust the agent-delegation chain ultimately hangs from.
function Passkeys() {
  const qc = useQueryClient()
  const { data: passkeys, isPending } = useQuery({
    queryKey: ["passkeys"],
    queryFn: async () => (await authClient.passkey.listUserPasskeys()).data ?? [],
  })
  const [adding, setAdding] = useState(false)

  const add = async () => {
    setAdding(true)
    try {
      const res = await authClient.passkey.addPasskey()
      if (res?.error) throw new Error(res.error.message ?? "Could not add a passkey")
      toast.success("Passkey added")
      qc.invalidateQueries({ queryKey: ["passkeys"] })
    } catch (e) {
      // Cancelling the browser prompt rejects — keep that quiet; surface real failures.
      const msg = (e as Error).message
      if (msg && !/cancel|abort|NotAllowed/i.test(msg)) toast.error(msg)
    } finally {
      setAdding(false)
    }
  }

  const remove = async (id: string) => {
    try {
      await authClient.passkey.deletePasskey({ id })
      qc.setQueryData(["passkeys"], (list: { id: string }[] | undefined) =>
        list?.filter((p) => p.id !== id),
      )
      toast.success("Passkey removed")
    } catch {
      toast.error("Could not remove that passkey")
      qc.invalidateQueries({ queryKey: ["passkeys"] })
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-foreground">Passkeys</div>
        <Button
          variant="secondary"
          size="sm"
          onClick={add}
          loading={adding}
          data-testid="passkey-add"
        >
          {adding ? "Waiting…" : "Add passkey"}
        </Button>
      </div>
      {isPending ? (
        <SettingsListSkeleton />
      ) : !passkeys || passkeys.length === 0 ? (
        <EmptyState>No passkeys yet. Add one for a phishing-resistant, one-tap sign-in.</EmptyState>
      ) : (
        <SettingsGroup>
          {passkeys.map((p) => (
            <div
              key={p.id}
              data-testid={`passkey-row-${p.id}`}
              className="flex items-center gap-3 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {p.name || "Passkey"}
                </div>
                <div className="text-2xs text-muted-foreground">
                  Added {new Date(p.createdAt).toLocaleDateString()}
                </div>
              </div>
              <Button
                data-testid={`passkey-remove-${p.id}`}
                variant="destructive-ghost"
                size="sm"
                onClick={() => remove(p.id)}
              >
                Remove
              </Button>
            </div>
          ))}
        </SettingsGroup>
      )}
    </div>
  )
}

// Set or change your password. The dialog collects the current password (Better Auth
// requires it) and the new one; on success every OTHER session is revoked server-side.
function PasswordRow() {
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")

  const submit = async () => {
    setErr("")
    setBusy(true)
    try {
      await api.changePassword(current, next)
      toast.success("Password updated. Other sessions were signed out.")
      setOpen(false)
      setCurrent("")
      setNext("")
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not update your password.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingRow
      label="Password"
      description="Used with your email to sign in. Changing it signs out your other sessions."
    >
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" data-testid="security-change-password">
            Change password
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>
              Enter your current password, then a new one (at least 8 characters).
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            {err && <StatusPanel tone="danger" layout="inline" title={err} />}
            <FormField label="Current password" htmlFor="cur-password">
              <Input
                id="cur-password"
                data-testid="security-current-password"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </FormField>
            <FormField label="New password" htmlFor="new-password">
              <Input
                id="new-password"
                data-testid="security-new-password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </FormField>
            <DialogFooter>
              <Button
                type="submit"
                loading={busy}
                disabled={!current || next.length < 8}
                data-testid="security-save-password"
              >
                {busy ? "Saving…" : "Update password"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </SettingRow>
  )
}

// Your account email: shows the address + a verified/unverified badge, a resend action while
// unverified, and (where mail can deliver) a change-email dialog that confirms the new
// address before switching.
function EmailRow({
  email,
  verified,
  canChange,
}: {
  email: string
  verified: boolean
  canChange: boolean
}) {
  const [resending, setResending] = useState(false)
  const resend = async () => {
    setResending(true)
    try {
      await api.sendVerificationEmail(email, `${window.location.origin}/`)
      toast.success("Verification email sent — check your inbox.")
    } catch {
      toast.error("Could not send the verification email.")
    } finally {
      setResending(false)
    }
  }

  return (
    <SettingRow
      label={
        <span className="flex items-center gap-2">
          Email
          {verified ? (
            <Badge variant="secondary">Verified</Badge>
          ) : (
            <Badge variant="outline">Unverified</Badge>
          )}
        </span>
      }
      description={email}
    >
      {!verified && canChange && (
        <Button
          variant="ghost"
          size="sm"
          onClick={resend}
          loading={resending}
          data-testid="security-resend-verification"
        >
          Resend verification
        </Button>
      )}
      {canChange && <ChangeEmailDialog />}
    </SettingRow>
  )
}

function ChangeEmailDialog() {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")

  const submit = async () => {
    setErr("")
    setBusy(true)
    try {
      await api.changeEmail(email, `${window.location.origin}/`)
      toast.success(`Confirm the change from the link we sent to ${email}.`)
      setOpen(false)
      setEmail("")
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not change your email.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="security-change-email">
          Change
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change email</DialogTitle>
          <DialogDescription>
            We'll send a confirmation link to the new address. Your email changes only once you
            click it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          {err && <StatusPanel tone="danger" layout="inline" title={err} />}
          <FormField label="New email" htmlFor="new-email">
            <Input
              id="new-email"
              data-testid="security-new-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </FormField>
          <DialogFooter>
            <Button
              type="submit"
              loading={busy}
              disabled={!email}
              data-testid="security-save-email"
            >
              {busy ? "Sending…" : "Send confirmation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

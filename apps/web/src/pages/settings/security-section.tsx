import { useEffect, useState } from "react"
import { ApiError, type AuthCapabilities, api } from "@/api"
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
    </SettingsSection>
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

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { QRCodeSVG } from "qrcode.react"
import { useEffect, useState } from "react"
import { type AuthCapabilities, api } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
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
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  REGEXP_ONLY_DIGITS,
} from "@/components/ui/input-otp"
import { toast } from "@/components/ui/sonner"
import { useAuth } from "@/ctx"
import { authClient } from "@/lib/auth-client"
import { connectedAgentsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
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
      <ConnectedAgents />
      <Sessions />
      <DeleteAccount />
    </SettingsSection>
  )
}

// The friendly bit of each derive:* scope, so the grant's blast radius reads at a glance
// (mirrors the server consent screen). Non-derive scopes (openid/profile/…) are plumbing —
// hidden here; we surface only what the agent can DO in Derive.
const SCOPE_LABEL: Record<string, string> = {
  "derive:read": "Read",
  "derive:comment": "Comment",
  "derive:propose": "Propose",
  "derive:publish": "Publish",
  "derive:review": "Review",
}

// Connected agents — the OAuth clients (MCP agents like Claude) the user authorized to act
// on their behalf. Listing + revocation make delegation legible and reversible: you can
// always see what may act as you, and cut it off. The moat's human-facing trust surface.
function ConnectedAgents() {
  const qc = useQueryClient()
  const { data: agents, isPending, isError, refetch } = useQuery(connectedAgentsQuery())
  const [confirming, setConfirming] = useState<string | null>(null)

  const revokeMut = useApiMutation({
    mutationFn: (clientId: string) => api.revokeConnectedAgent(clientId),
    onSuccess: (_data, clientId) =>
      qc.setQueryData(connectedAgentsQuery().queryKey, (list) =>
        list?.filter((a) => a.clientId !== clientId),
      ),
    success: "Access revoked — the agent must be re-authorized to act again",
    invalidate: [connectedAgentsQuery().queryKey],
  })
  const revoke = (clientId: string) => revokeMut.mutate(clientId)

  // No connected agents (and not loading) → keep the surface quiet; this is an advanced,
  // opt-in area that only appears once you've actually authorized an agent.
  if (!isPending && !isError && (!agents || agents.length === 0)) return null

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-sm font-medium text-foreground">Connected agents</div>
        <p className="text-sm text-muted-foreground">
          Agents you've authorized to act on your behalf. Revoke any at any time.
        </p>
      </div>
      {isPending ? (
        <SettingsListSkeleton />
      ) : isError ? (
        <StatusPanel
          tone="danger"
          title="Couldn't load connected agents"
          description="This is usually temporary."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="security-agents-retry"
              onClick={() => refetch()}
            >
              Try again
            </Button>
          }
        />
      ) : (
        <SettingsGroup>
          {agents?.map((a) => {
            const perms = a.scopes.map((s) => SCOPE_LABEL[s]).filter(Boolean)
            return (
              <div
                key={a.clientId}
                data-testid={`agent-conn-${a.clientId}`}
                className="flex items-center gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">{a.clientName}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1">
                    {perms.length > 0 ? (
                      perms.map((p) => (
                        <Badge key={p} variant="secondary">
                          {p}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-2xs text-muted-foreground">Read-only</span>
                    )}
                    <span className="text-2xs text-muted-foreground">
                      · since {new Date(a.grantedAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
                <Button
                  data-testid={`agent-conn-revoke-${a.clientId}`}
                  variant="destructive-ghost"
                  size="sm"
                  onClick={() => setConfirming(a.clientId)}
                >
                  Revoke
                </Button>
              </div>
            )
          })}
        </SettingsGroup>
      )}
      {confirming && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirming(null)}
          title="Revoke this agent's access?"
          description="It loses access immediately and must be re-authorized before it can act on your behalf again."
          confirmLabel="Revoke"
          onConfirm={() => revoke(confirming)}
        />
      )}
    </div>
  )
}

// Danger zone — permanently delete the account. Gated by the current password + a typed
// confirmation; the server blocks it if the user is the sole owner of a shared workspace.
function DeleteAccount() {
  const { setMe } = useAuth()
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")

  const del = useApiMutation({
    mutationFn: async () => {
      const res = await authClient.deleteUser({ password })
      if (res?.error) throw new Error(res.error.message ?? "Could not delete your account.")
    },
    errorToast: false, // rendered inline in the dialog
    onSuccess: () => {
      setMe(null)
      nav({ to: "/login" })
    },
  })
  const submit = () => del.mutate()

  return (
    <SettingsGroup>
      <SettingRow
        label={<span className="font-medium text-destructive">Delete account</span>}
        description="Permanently delete your account and remove you from every workspace. This can't be undone."
      >
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="destructive-ghost" size="sm" data-testid="delete-account">
              Delete account
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete your account</DialogTitle>
              <DialogDescription>
                This permanently deletes your account, sessions, and passkeys, and removes you from
                every workspace. Artifacts you authored in shared workspaces stay, but are
                anonymized. This can't be undone.
              </DialogDescription>
            </DialogHeader>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                submit()
              }}
            >
              {del.error && <StatusPanel tone="danger" layout="inline" title={del.error.message} />}
              <FormField label="Password" htmlFor="del-password">
                <Input
                  id="del-password"
                  data-testid="delete-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </FormField>
              <FormField label={'Type "delete" to confirm'} htmlFor="del-confirm">
                <Input
                  id="del-confirm"
                  data-testid="delete-confirm"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="delete"
                />
              </FormField>
              <DialogFooter>
                <Button
                  type="submit"
                  variant="destructive"
                  loading={del.isPending}
                  disabled={!password || confirm.trim().toLowerCase() !== "delete"}
                  data-testid="delete-confirm-btn"
                >
                  {del.isPending ? "Deleting…" : "Delete my account"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </SettingRow>
    </SettingsGroup>
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
  const [totpURI, setTotpURI] = useState("")
  const [secret, setSecret] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [backup, setBackup] = useState<string[]>([])

  const start = useApiMutation({
    mutationFn: async () => {
      const res = await authClient.twoFactor.enable({ password })
      if (res?.error || !res?.data) throw new Error(res?.error?.message ?? "Could not start setup.")
      return res.data
    },
    errorToast: false, // rendered inline in the dialog
    onSuccess: (data) => {
      // totpURI is otpauth://totp/Derive:email?secret=…&issuer=Derive — the QR encodes it
      // directly; pull the secret out too for the manual "can't scan?" fallback.
      setTotpURI(data.totpURI)
      setSecret(new URL(data.totpURI).searchParams.get("secret") ?? "")
      setBackup(data.backupCodes ?? [])
      setStep("confirm")
    },
  })

  const confirm = useApiMutation({
    mutationFn: async () => {
      const res = await authClient.twoFactor.verifyTotp({ code })
      if (res?.error) throw new Error(res.error.message ?? "That code didn't work.")
    },
    errorToast: false, // rendered inline in the dialog
    onSuccess: async () => {
      await onDone()
      toast.success("Two-factor authentication is on")
      setOpen(false)
      reset()
    },
  })
  // Both the OTP's auto-submit (on the sixth digit) and the form (Enter / Turn on) land here;
  // the in-flight guard stops a stray Enter right after auto-submit from firing verifyTotp twice.
  const submitConfirm = () => {
    if (!confirm.isPending) confirm.mutate()
  }

  // Clear the wizard + both mutations' errors when the dialog closes or a round completes.
  // A function declaration (hoisted) so confirm's onSuccess above can call it.
  function reset() {
    setStep("password")
    setPassword("")
    setCode("")
    setTotpURI("")
    setSecret("")
    setShowKey(false)
    setBackup([])
    start.reset()
    confirm.reset()
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
              : "Scan the QR code with your authenticator app, save your backup codes, then enter a code to confirm."}
          </DialogDescription>
        </DialogHeader>
        {(start.error ?? confirm.error) && (
          <StatusPanel
            tone="danger"
            layout="inline"
            title={(start.error ?? confirm.error)?.message ?? ""}
          />
        )}
        {step === "password" ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              start.mutate()
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
              <Button
                type="submit"
                loading={start.isPending}
                disabled={!password}
                data-testid="2fa-start"
              >
                {start.isPending ? "Starting…" : "Continue"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              submitConfirm()
            }}
          >
            <div className="flex flex-col items-center gap-3">
              {/* The QR is the primary path: authenticator apps scan the otpauth:// URI. It
                  renders dark-on-white regardless of theme so it always scans — a dark-mode
                  QR on the dark canvas is unreliable. */}
              {totpURI && (
                // White card + padding is the QR's quiet zone. It stays white in dark mode on
                // purpose: QRCodeSVG defaults to black-on-white, and a dark-mode QR on the dark
                // canvas is unreliable to scan. The p-3 padding is the required margin.
                <div data-testid="2fa-qr" className="rounded-lg border border-border bg-white p-3">
                  <QRCodeSVG
                    value={totpURI}
                    size={168}
                    marginSize={0}
                    title="Two-factor authentication setup QR code"
                  />
                </div>
              )}
              {!showKey ? (
                <button
                  type="button"
                  data-testid="2fa-show-key"
                  className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => setShowKey(true)}
                >
                  Can’t scan? Enter the key manually
                </button>
              ) : (
                <div className="flex w-full flex-col gap-1.5">
                  <div className="text-xs font-medium text-muted-foreground">
                    Setup key — type this into your app instead
                  </div>
                  <code
                    data-testid="2fa-secret"
                    className="block break-all rounded-md bg-secondary px-2.5 py-1.5 font-mono text-2xs text-foreground"
                  >
                    {secret}
                  </code>
                </div>
              )}
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
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="2fa-copy-backup"
                    onClick={() => {
                      navigator.clipboard?.writeText(backup.join("\n"))
                      toast.success("Backup codes copied")
                    }}
                  >
                    Copy codes
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="2fa-download-backup"
                    onClick={() => {
                      const blob = new Blob([`${backup.join("\n")}\n`], { type: "text/plain" })
                      const url = URL.createObjectURL(blob)
                      const a = document.createElement("a")
                      a.href = url
                      a.download = "derive-backup-codes.txt"
                      a.click()
                      URL.revokeObjectURL(url)
                    }}
                  >
                    Download
                  </Button>
                </div>
              </div>
            )}
            <FormField label="Confirm a code from your app" htmlFor="tfa-code">
              <InputOTP
                id="tfa-code"
                data-testid="2fa-confirm-code"
                maxLength={6}
                pattern={REGEXP_ONLY_DIGITS}
                inputMode="numeric"
                autoFocus
                value={code}
                onChange={setCode}
                // Auto-submit the moment all six digits land (typed or pasted) — no reaching
                // for the button. The mutation guards against a double-fire.
                onComplete={submitConfirm}
              >
                <InputOTPGroup>
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <InputOTPSlot key={i} index={i} />
                  ))}
                </InputOTPGroup>
              </InputOTP>
            </FormField>
            <DialogFooter>
              <Button
                type="submit"
                loading={confirm.isPending}
                disabled={code.length !== 6}
                data-testid="2fa-confirm"
              >
                {confirm.isPending ? "Verifying…" : "Turn on"}
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

  const disable = useApiMutation({
    mutationFn: async () => {
      const res = await authClient.twoFactor.disable({ password })
      if (res?.error) throw new Error(res.error.message ?? "Could not turn it off.")
    },
    errorToast: false, // rendered inline in the dialog
    onSuccess: async () => {
      await onDone()
      toast.success("Two-factor authentication is off")
      setOpen(false)
      setPassword("")
    },
  })
  const submit = () => disable.mutate()

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
          {disable.error && (
            <StatusPanel tone="danger" layout="inline" title={disable.error.message} />
          )}
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
              loading={disable.isPending}
              disabled={!password}
              data-testid="2fa-off-confirm"
            >
              {disable.isPending ? "Turning off…" : "Turn off"}
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
  const {
    data: sessions,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const r = await authClient.listSessions()
      if (r.error) throw new Error(r.error.message ?? "Couldn't load your sessions")
      return r.data ?? []
    },
  })

  const revokeOthers = useApiMutation({
    mutationFn: async () => {
      const res = await authClient.revokeOtherSessions()
      if (res?.error) throw new Error(res.error.message ?? "Could not sign out the other sessions")
    },
    success: "Signed out your other devices",
    invalidate: [["sessions"]],
  })

  const count = sessions?.length ?? 0
  return (
    <SettingsGroup>
      <SettingRow
        label="Active sessions"
        description={
          isPending
            ? "Loading your signed-in devices…"
            : isError
              ? "Couldn't load your sessions."
              : count <= 1
                ? "You're signed in on this device only."
                : `You're signed in on ${count} devices.`
        }
      >
        {isError ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            data-testid="sessions-retry"
          >
            Try again
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => revokeOthers.mutate()}
            loading={revokeOthers.isPending}
            disabled={count <= 1}
            data-testid="sessions-revoke-others"
          >
            Sign out other devices
          </Button>
        )}
      </SettingRow>
    </SettingsGroup>
  )
}

// Passkeys (WebAuthn) — the phishing-resistant, passwordless factor. List, add, and remove
// them here; adding one runs the browser's create-credential ceremony via the auth client.
// This is the human root of trust the agent-delegation chain ultimately hangs from.
function Passkeys() {
  const qc = useQueryClient()
  const {
    data: passkeys,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["passkeys"],
    queryFn: async () => {
      const r = await authClient.passkey.listUserPasskeys()
      if (r.error) throw new Error(r.error.message ?? "Couldn't load your passkeys")
      return r.data ?? []
    },
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
      // mutation-ignore: WebAuthn cancel/abort must stay silent; the primitive has no
      // per-error suppression, so this passkey add is deliberately hand-rolled.
      if (msg && !/cancel|abort|NotAllowed/i.test(msg)) toast.error(msg) // mutation-ignore
    } finally {
      setAdding(false)
    }
  }

  const removeMut = useApiMutation({
    mutationFn: async (id: string) => {
      const res = await authClient.passkey.deletePasskey({ id })
      if (res?.error) throw new Error(res.error.message ?? "Could not remove that passkey")
    },
    onSuccess: (_data, id) =>
      qc.setQueryData(["passkeys"], (list: { id: string }[] | undefined) =>
        list?.filter((p) => p.id !== id),
      ),
    success: "Passkey removed",
    invalidate: [["passkeys"]],
  })
  const remove = (id: string) => removeMut.mutate(id)

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
      ) : isError ? (
        <StatusPanel
          tone="danger"
          layout="inline"
          title="Couldn't load your passkeys"
          description="This is usually temporary."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="passkeys-retry"
              onClick={() => refetch()}
            >
              Try again
            </Button>
          }
        />
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

  const change = useApiMutation({
    mutationFn: () => api.changePassword(current, next),
    errorToast: false, // rendered inline in the dialog
    success: "Password updated. Other sessions were signed out.",
    onSuccess: () => {
      setOpen(false)
      setCurrent("")
      setNext("")
    },
  })
  const submit = () => change.mutate()

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
            {change.error && (
              <StatusPanel tone="danger" layout="inline" title={change.error.message} />
            )}
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
                loading={change.isPending}
                disabled={!current || next.length < 8}
                data-testid="security-save-password"
              >
                {change.isPending ? "Saving…" : "Update password"}
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
  const resendMut = useApiMutation({
    mutationFn: () => api.sendVerificationEmail(email, `${window.location.origin}/`),
    success: "Verification email sent — check your inbox.",
  })
  const resend = () => resendMut.mutate()

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
          loading={resendMut.isPending}
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

  const change = useApiMutation({
    mutationFn: () => api.changeEmail(email, `${window.location.origin}/`),
    errorToast: false, // rendered inline in the dialog
    success: () => `Confirm the change from the link we sent to ${email}.`,
    onSuccess: () => {
      setOpen(false)
      setEmail("")
    },
  })
  const submit = () => change.mutate()

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
          {change.error && (
            <StatusPanel tone="danger" layout="inline" title={change.error.message} />
          )}
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
              loading={change.isPending}
              disabled={!email}
              data-testid="security-save-email"
            >
              {change.isPending ? "Sending…" : "Send confirmation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

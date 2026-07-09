import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, type ReactNode, useState } from "react"
import { api } from "@/api"
import { FormField } from "@/components/shared/form-field"
import { Logo } from "@/components/shared/logo"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const route = getRouteApi("/reset-password")

// The calm chrome-less shell shared with /login: one focused column on a solid canvas,
// wordmark on top, a headline voice moment, then the form.
function Shell({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: ReactNode
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-card dark:bg-background">
      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="flex w-full max-w-xs flex-col gap-8">
          <div className="flex flex-col items-center gap-5 text-center">
            <div className="flex items-center gap-2">
              <Logo size={26} />
              <span className="font-serif text-lg font-medium tracking-tight">Derive</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <h1 className="font-serif text-3xl font-medium tracking-tight text-balance text-foreground">
                {title}
              </h1>
              <p className="text-sm text-pretty text-muted-foreground">{subtitle}</p>
            </div>
          </div>
          {children}
        </div>
      </main>
    </div>
  )
}

// A quiet link back to sign-in, in the muted register (matches the login footer voice).
function BackToSignIn() {
  return (
    <p className="text-center text-sm text-muted-foreground">
      <Button
        asChild
        variant="link"
        data-testid="reset-back-to-signin"
        className="h-auto p-0 align-baseline"
      >
        <Link to="/login">Back to sign in</Link>
      </Button>
    </p>
  )
}

export function ResetPassword() {
  const { token, error } = route.useSearch()
  // The emailed link lands here with a token; without one this is the request form.
  return token ? <Complete token={token} /> : <Request expired={error === "INVALID_TOKEN"} />
}

// Step 1 — request a reset link. The response is deliberately identical whether or not
// the address has an account (the server never reveals which emails exist), so on success
// we always show the same neutral "check your email" confirmation.
function Request({ expired }: { expired: boolean }) {
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState("")

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr("")
    setBusy(true)
    try {
      const origin = typeof window !== "undefined" ? window.location.origin : ""
      await api.requestPasswordReset(email, `${origin}/reset-password`)
      setSent(true)
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  if (sent)
    return (
      <Shell
        title="Check your email"
        subtitle="If an account exists for that address, a reset link is on its way."
      >
        <div className="flex flex-col gap-6">
          <StatusPanel
            tone="success"
            layout="inline"
            title={`We sent a reset link to ${email}.`}
            description="The link expires in an hour. Check your spam folder if it doesn't arrive."
          />
          <BackToSignIn />
        </div>
      </Shell>
    )

  return (
    <Shell
      title="Reset your password"
      subtitle="Enter your email and we'll send you a link to choose a new password."
    >
      <form onSubmit={submit} className="flex flex-col gap-6">
        <div className="flex flex-col gap-4">
          {expired && (
            <StatusPanel
              tone="warning"
              layout="inline"
              title="That reset link has expired."
              description="Request a fresh one below."
            />
          )}
          {err && (
            <div data-testid="reset-error">
              <StatusPanel tone="danger" layout="inline" title={err} />
            </div>
          )}
          <FormField label="Email" htmlFor="reset-email">
            <Input
              id="reset-email"
              data-testid="reset-email"
              type="email"
              name="email"
              autoComplete="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </FormField>
          <Button
            data-testid="reset-request-submit"
            variant="default"
            size="lg"
            type="submit"
            loading={busy}
            disabled={!email}
            className="w-full"
          >
            {busy ? "Sending…" : "Send reset link"}
          </Button>
        </div>
        <BackToSignIn />
      </form>
    </Shell>
  )
}

// Step 2 — set a new password with the emailed token. On success the server has revoked
// every other session (revokeSessionsOnPasswordReset), so we send them to sign in fresh.
function Complete({ token }: { token: string }) {
  const nav = useNavigate()
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr("")
    setBusy(true)
    try {
      await api.resetPassword(token, password)
      // Password changed + other sessions revoked — sign in with the new one.
      nav({ to: "/login", search: { reset: true } })
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Shell title="Choose a new password" subtitle="Pick something you haven't used before.">
      <form onSubmit={submit} className="flex flex-col gap-6">
        <div className="flex flex-col gap-4">
          {err && (
            <div data-testid="reset-error">
              <StatusPanel tone="danger" layout="inline" title={err} />
            </div>
          )}
          <FormField label="New password" htmlFor="reset-password">
            <Input
              id="reset-password"
              data-testid="reset-password"
              type="password"
              name="password"
              autoComplete="new-password"
              required
              minLength={8}
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
            />
          </FormField>
          <Button
            data-testid="reset-submit"
            variant="default"
            size="lg"
            type="submit"
            loading={busy}
            disabled={password.length < 8}
            className="w-full"
          >
            {busy ? "Saving…" : "Set new password"}
          </Button>
        </div>
        <BackToSignIn />
      </form>
    </Shell>
  )
}

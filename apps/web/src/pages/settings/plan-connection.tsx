import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useApiMutation } from "@/lib/use-api-mutation"

export function PlanConnection({
  accountId,
  resumeId,
  kind = "login",
  onDone,
}: {
  accountId?: string
  resumeId?: string
  kind?: "login" | "api_key"
  onDone: (accountId?: string) => void
}) {
  const [id, setId] = useState(resumeId)
  const [name, setName] = useState("")
  const [secret, setSecret] = useState("")
  const [copied, setCopied] = useState(false)
  const qc = useQueryClient()
  const options = useQuery({
    queryKey: ["account-login-options"],
    queryFn: api.accountLoginOptions,
  })
  const state = useQuery({
    queryKey: ["account-login", id],
    enabled: !!id,
    queryFn: () => api.accountLogin(id ?? ""),
    refetchIntervalInBackground: true,
    refetchInterval: (q) =>
      ["starting", "awaiting", "checking"].includes(q.state.data?.phase ?? "") ? 2000 : false,
  })
  const start = useApiMutation({
    mutationFn: () =>
      api.connectPlan({
        account_id: accountId ?? id,
        name,
        kind,
        ...(kind === "api_key" ? { secret: secret.trim() } : {}),
      }),
    invalidate: [["accounts"]],
    errorToast: false,
    onSuccess: (result) => {
      qc.setQueryData(["account-login", result.id], result)
      setId(result.id)
      setSecret("")
    },
  })
  const cancel = useApiMutation({
    mutationFn: () => api.cancelAccountLogin(id ?? ""),
    invalidate: [["accounts"], ["account-login", id]],
    onSuccess: () => onDone(),
  })
  const phase = state.data?.phase
  const ready = phase === "ready"
  const waiting = phase === "awaiting"
  const active = phase === "starting" || phase === "checking"
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["accounts"] })
    onDone(ready ? id : undefined)
  }
  return (
    <section
      data-testid="plan-connection"
      aria-live="polite"
      className="flex max-w-xl flex-col gap-4 rounded-xl border border-border p-5"
    >
      <div>
        <h3 className="text-base font-medium">
          {ready
            ? "You’re connected"
            : waiting
              ? "Approve in Codex"
              : active
                ? phase === "checking"
                  ? "Checking your access…"
                  : "Getting your connection ready…"
                : kind === "api_key"
                  ? "Reconnect your API key"
                  : "Bring your Codex plan"}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {ready
            ? "Your account is ready for cloud tasks. Let’s go."
            : waiting
              ? "Copy this code, open Codex, and approve the connection. We’ll finish here."
              : active
                ? "You can leave this page. Open the account again to continue."
                : kind === "api_key"
                  ? "Add your new key. We’ll check access and keep the same account for your agents."
                  : `Approve once. Your agents use your plan.${!accountId && !resumeId ? " This account stays private." : ""}`}
        </p>
      </div>
      {waiting && state.data?.user_code && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3 rounded-lg bg-muted p-3">
            <code data-testid="plan-device-code" className="text-xl tracking-widest">
              {state.data.user_code}
            </code>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="plan-copy-code"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(state.data?.user_code ?? "")
                  setCopied(true)
                } catch {
                  setCopied(false)
                }
              }}
            >
              {copied ? "Copied" : "Copy code"}
            </Button>
          </div>
          <Button asChild data-testid="plan-approve">
            <a
              href={state.data.verification_url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Codex to approve
            </a>
          </Button>
          <p className="text-xs text-muted-foreground">
            Keep this code private. If prompted, enable device login in your ChatGPT security
            settings.
          </p>
        </div>
      )}
      {phase === "failed" && (
        <p role="alert" data-testid="plan-error" className="text-sm text-destructive">
          {state.data?.message ?? "This connection ended. Let’s try again."}
        </p>
      )}
      {state.data?.can_restore && !ready && (
        <p className="text-xs text-muted-foreground">
          New cloud tasks wait while you reconnect. Cancel to keep your previous connection.
        </p>
      )}
      {start.error && (
        <p role="alert" className="text-sm text-destructive">
          {start.error.message}
        </p>
      )}
      {state.isError && (
        <LoadError
          layout="inline"
          title="Couldn’t check your connection."
          testId="plan-retry-status"
          onRetry={() => void state.refetch()}
        />
      )}
      {options.isError && (
        <LoadError
          layout="inline"
          title="Couldn’t load connection options."
          testId="plan-retry-options"
          onRetry={() => void options.refetch()}
        />
      )}
      {!id && !accountId && (
        <Input
          aria-label="Account name"
          data-testid="plan-name"
          placeholder="Name your plan (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
        />
      )}
      {kind === "api_key" && !waiting && !active && !ready && (
        <Input
          type="password"
          autoComplete="off"
          aria-label="API key"
          data-testid="plan-api-key"
          placeholder="Paste your new API key"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      )}
      {!id && options.data && !options.data.device_login && (
        <p data-testid="plan-unavailable" className="text-sm text-muted-foreground">
          Plan connections need cloud compute enabled for this workspace. Check Settings →
          Connections, or import a login or add an API key.
        </p>
      )}
      {!waiting && !active && !ready && (
        <p className="text-xs text-muted-foreground">
          We run one tiny access check before saving the connection.{" "}
          {kind === "api_key"
            ? "Your provider may charge for this check."
            : "It uses your plan allowance."}
        </p>
      )}
      <div className="flex items-center gap-2">
        {ready ? (
          <Button type="button" data-testid="plan-done" onClick={done}>
            Let’s go
          </Button>
        ) : (
          !waiting &&
          !active && (
            <Button
              type="button"
              data-testid="plan-start"
              disabled={
                !options.data?.device_login || (kind === "api_key" && secret.trim().length < 8)
              }
              loading={start.isPending}
              onClick={() => start.mutate()}
            >
              {id ? "Try again" : kind === "api_key" ? "Check and connect" : "Connect with Codex"}
            </Button>
          )
        )}
        <Button
          type="button"
          variant="ghost"
          data-testid="plan-cancel"
          disabled={start.isPending}
          loading={cancel.isPending}
          onClick={() => (ready || !id ? done() : cancel.mutate())}
        >
          {ready ? "Close" : "Cancel"}
        </Button>
      </div>
    </section>
  )
}

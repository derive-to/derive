import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { api, type WorkspaceDomain, type WorkspaceSubdomain } from "@/api"
import { Icon } from "@/components/icons"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { EmptyState } from "@/components/shared/empty-state"
import { fieldError } from "@/components/shared/field-error"
import { ListRow } from "@/components/shared/list-row"
import { LoadError } from "@/components/shared/load-error"
import { SettingsEmpty } from "@/components/shared/settings-empty"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusBadge, type StatusTone } from "@/components/shared/status-badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import { useCopy } from "@/lib/clipboard"
import { billingQuery, customDomainsQuery } from "@/lib/queries"
import { labelError, normalizeLabel } from "@/lib/subdomain-label"
import { useApiMutation } from "@/lib/use-api-mutation"
import { AddForm } from "./add-form"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

// A ref-shaped placeholder (`<title-slug>-<short id>`) for the link previews.
const SAMPLE_REF = "q3-update-k7m2x9pq"

export function CustomDomainsSection() {
  const qc = useQueryClient()
  const { data: state, isPending, isError, refetch } = useQuery(customDomainsQuery())
  const reload = () => qc.invalidateQueries({ queryKey: customDomainsQuery().queryKey })

  const description =
    "Put your workspace's name on its links. Claim a subdomain and every shared artifact is also served there, or attach a domain you own."

  if (isPending)
    return (
      <SettingsSection title="Domains" description={description}>
        <SettingsListSkeleton />
      </SettingsSection>
    )

  if (isError || !state)
    return (
      <SettingsSection title="Domains" description={description}>
        <LoadError
          title="Couldn’t load domains"
          testId="custom-domains-retry"
          onRetry={() => refetch()}
        />
      </SettingsSection>
    )

  // Neither kind is offered on this server: the section itself is the empty state.
  if (!state.subdomain_base && !state.enabled)
    return (
      <SettingsSection title="Domains" description={description}>
        <EmptyState>Domains aren't enabled on this server.</EmptyState>
      </SettingsSection>
    )

  return (
    <SettingsSection title="Domains" description={description}>
      {state.subdomain_base && (
        <SubdomainGroup base={state.subdomain_base} current={state.subdomain} onChanged={reload} />
      )}
      <SettingsGroup
        title="Your own domain"
        description="Attach a domain you control. Every artifact is then served at your-domain/<id>. Cloudflare for SaaS issues and renews the TLS cert."
      >
        {state.enabled ? (
          <>
            <NewDomain cnameTarget={state.cname_target} onCreated={reload} />
            {state.domains.length === 0 ? (
              <SettingsEmpty>No custom domains yet.</SettingsEmpty>
            ) : (
              state.domains.map((d) => <DomainRow key={d.host} domain={d} onChanged={reload} />)
            )}
          </>
        ) : (
          <SettingsEmpty>Custom domains aren't enabled on this server.</SettingsEmpty>
        )}
      </SettingsGroup>
    </SettingsSection>
  )
}

// ---- Workspace subdomain: <label>.<base> ---------------------------------------

function SubdomainGroup({
  base,
  current,
  onChanged,
}: {
  base: string
  current: WorkspaceSubdomain | null
  onChanged: () => void
}) {
  // Team feature: the server 402s an unentitled claim, so a Free workspace gets the
  // upgrade link in place of the form. The form stays disabled until billing answers.
  const { data: billing } = useQuery(billingQuery())
  const locked = billing ? !billing.custom_domain : false
  const [editing, setEditing] = useState(false)

  return (
    <SettingsGroup
      title="Workspace subdomain"
      description={`One name, on ${base}. It works the moment you claim it: no DNS, no certificate to wait for. Existing links keep working.`}
    >
      {current && !editing ? (
        <ClaimedRow
          current={current}
          onChange={() => setEditing(true)}
          onReleased={onChanged}
          locked={locked}
        />
      ) : locked ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3.5">
          <p className="text-sm text-muted-foreground">
            A workspace subdomain is part of the Team plan.
          </p>
          <Link
            to="/settings/$section"
            params={{ section: "billing" }}
            data-testid="subdomain-upgrade"
            className="text-sm font-medium underline underline-offset-2 hover:text-foreground"
          >
            Upgrade to Team
          </Link>
        </div>
      ) : (
        <ClaimForm
          base={base}
          initial={current?.label ?? ""}
          ready={!!billing}
          onDone={() => {
            setEditing(false)
            onChanged()
          }}
          onCancel={current ? () => setEditing(false) : undefined}
        />
      )}
    </SettingsGroup>
  )
}

function ClaimForm({
  base,
  initial,
  ready,
  onDone,
  onCancel,
}: {
  base: string
  initial: string
  ready: boolean
  onDone: () => void
  onCancel?: () => void
}) {
  const [value, setValue] = useState(initial)
  const label = normalizeLabel(value)
  const err = label ? labelError(label) : null
  const errField = fieldError("subdomain-error", err)
  const claim = useApiMutation({
    mutationFn: (l: string) => api.claimWorkspaceSubdomain(l),
    success: "Subdomain claimed. Your shared pages are live there now.",
    onSuccess: onDone,
  })
  return (
    <AddForm
      onSubmit={() => !err && label && claim.mutate(label)}
      submitLabel={initial ? "Change" : "Claim"}
      submitTestId="subdomain-claim"
      pending={claim.isPending}
      disabled={!ready || !label || !!err || label === initial}
      after={
        <>
          {/* How a link will read, updated as the label is typed. */}
          <p
            data-testid="subdomain-preview"
            className="truncate font-mono text-2xs text-muted-foreground"
          >
            Your links will read https://
            <span className="text-foreground">{label || "name"}</span>.{base}/{SAMPLE_REF}
          </p>
          {errField.node}
          {onCancel && (
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              data-testid="subdomain-cancel"
              onClick={onCancel}
            >
              Cancel
            </Button>
          )}
        </>
      }
    >
      <InputGroup className="min-w-60 flex-1">
        <InputGroupInput
          data-testid="subdomain-label"
          aria-label="Subdomain name"
          {...errField.aria}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="acme"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="font-mono"
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText className="font-mono">.{base}</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
    </AddForm>
  )
}

function ClaimedRow({
  current,
  onChange,
  onReleased,
  locked,
}: {
  current: WorkspaceSubdomain
  onChange: () => void
  onReleased: () => void
  locked: boolean
}) {
  const { copied, copy } = useCopy(1500)
  const [confirming, setConfirming] = useState(false)
  const release = useApiMutation({
    mutationFn: () => api.releaseWorkspaceSubdomain(),
    success: "Subdomain released",
    onSuccess: onReleased,
  })
  const sample = `${current.url}/${SAMPLE_REF}`
  return (
    <ListRow
      data-testid="subdomain-row"
      mono
      title={current.host}
      meta={`Claimed ${new Date(current.created_at).toLocaleDateString()}`}
      actions={
        <>
          <StatusBadge data-testid="subdomain-status" tone="ok">
            Live
          </StatusBadge>
          <Button
            variant="ghost"
            size="sm"
            data-testid="subdomain-copy"
            onClick={() => void copy(current.url, { success: "Copied" })}
          >
            {copied ? <Icon name="check" className="text-success" /> : <Icon name="copy" />}
            Copy
          </Button>
          {/* A lapsed plan keeps its label but can't pick a new one. */}
          {!locked && (
            <Button variant="ghost" size="sm" data-testid="subdomain-change" onClick={onChange}>
              Change
            </Button>
          )}
          <Button
            variant="destructive-ghost"
            size="sm"
            data-testid="subdomain-release"
            onClick={() => setConfirming(true)}
          >
            Remove
          </Button>
        </>
      }
      below={
        <>
          <div className="rounded-lg bg-secondary px-3 py-2">
            <p className="mb-1 font-mono text-2xs text-muted-foreground">
              Every shared artifact is also served here. A link reads:
            </p>
            <p className="truncate font-mono text-2xs text-foreground">{sample}</p>
          </div>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={`Remove ${current.host}?`}
            description="Links on this subdomain stop working immediately. Anyone can claim the name afterwards."
            confirmLabel="Remove"
            onConfirm={() => release.mutate()}
          />
        </>
      }
    />
  )
}

// ---- Custom domains: Cloudflare for SaaS ----------------------------------------

function NewDomain({
  cnameTarget,
  onCreated,
}: {
  cnameTarget: string | null
  onCreated: () => void
}) {
  const [host, setHost] = useState("")
  const addDomain = useApiMutation({
    mutationFn: (h: string) => api.addWorkspaceDomain(h),
    success: "Domain added. Add the DNS records to finish setup.",
    onSuccess: () => {
      setHost("")
      onCreated()
    },
  })
  const add = () => {
    const h = host.trim()
    if (h) addDomain.mutate(h)
  }
  return (
    <AddForm
      onSubmit={add}
      submitLabel="Add"
      submitTestId="domain-add"
      pending={addDomain.isPending}
      disabled={!host.trim()}
      after={
        cnameTarget && (
          <p className="font-mono text-2xs text-muted-foreground">
            CNAME your domain to <span className="text-foreground">{cnameTarget}</span>.
          </p>
        )
      }
    >
      <Input
        data-testid="domain-host"
        aria-label="Custom domain"
        value={host}
        onChange={(e) => setHost(e.target.value)}
        placeholder="docs.acme.com"
        className="min-w-60 flex-1 font-mono"
      />
    </AddForm>
  )
}

// Verification state → tone: a live cert is confirmed good, a failed issuance
// errored, and pending means DNS work is still on the user (attention, not the accent).
const statusTone = (s: string): { tone: StatusTone; label: string } =>
  s === "active"
    ? { tone: "ok", label: "Active" }
    : s === "error"
      ? { tone: "error", label: "Error" }
      : { tone: "attention", label: "Pending" }

function DomainRow({ domain, onChanged }: { domain: WorkspaceDomain; onChanged: () => void }) {
  const b = statusTone(domain.status)
  const [confirming, setConfirming] = useState(false)
  const refreshMut = useApiMutation({
    mutationFn: () => api.refreshWorkspaceDomain(domain.host),
    onSuccess: () => onChanged(),
  })
  const refresh = () => refreshMut.mutate()
  const removeMut = useApiMutation({
    mutationFn: () => api.removeWorkspaceDomain(domain.host),
    success: "Domain removed",
    onSuccess: () => onChanged(),
  })
  const remove = () => removeMut.mutate()
  return (
    <ListRow
      data-testid={`domain-row-${domain.host}`}
      mono
      title={domain.host}
      actions={
        <>
          <StatusBadge data-testid="domain-status" tone={b.tone}>
            {b.label}
          </StatusBadge>
          {domain.status !== "active" && (
            <Button data-testid="domain-refresh" variant="ghost" size="sm" onClick={refresh}>
              Refresh
            </Button>
          )}
          <Button
            data-testid="domain-remove"
            variant="destructive-ghost"
            size="sm"
            onClick={() => setConfirming(true)}
          >
            Remove
          </Button>
        </>
      }
      below={
        <>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={`Remove ${domain.host}?`}
            description="Artifacts stop serving on this domain immediately; the TLS cert is released."
            confirmLabel="Remove"
            onConfirm={remove}
          />
          {domain.status !== "active" && domain.records && domain.records.length > 0 && (
            <div className="rounded-lg bg-secondary px-3 py-2">
              <p className="mb-1 font-mono text-2xs text-muted-foreground">
                Add these DNS records at your registrar:
              </p>
              {domain.records.map((r) => (
                <div
                  key={`${r.type}-${r.name}`}
                  className="truncate font-mono text-2xs text-foreground"
                >
                  <span className="text-muted-foreground">{r.type}</span> {r.name} → {r.value}
                </div>
              ))}
            </div>
          )}
        </>
      }
    />
  )
}

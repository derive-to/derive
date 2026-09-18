import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Copy } from "lucide-react"
import { useState } from "react"
import { api, type WorkspaceDomain, type WorkspaceSubdomain } from "@/api"
import { Icon } from "@/components/icons"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { EmptyState } from "@/components/shared/empty-state"
import { ListRow } from "@/components/shared/list-row"
import { LoadError } from "@/components/shared/load-error"
import { SettingsEmpty } from "@/components/shared/settings-empty"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusBadge, type StatusTone } from "@/components/shared/status-badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCopy } from "@/lib/clipboard"
import { billingQuery, customDomainsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { AddForm } from "./add-form"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

// The stand-in for an artifact's ref in every "here is how your link will read"
// preview. Real refs are `<title-slug>-<short id>`; the preview keeps the shape
// without pretending to be a real page.
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

  // Neither path is offered here (a self-host with no base and no Cloudflare): the
  // section IS the empty state, so it keeps the page-level treatment.
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

// What the server will accept, mirrored so the preview and the button agree with the
// 400 the API would send: a DNS label, lower-case, no hyphen at either edge.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const normalizeLabel = (raw: string) =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .slice(0, 63)

function SubdomainGroup({
  base,
  current,
  onChanged,
}: {
  base: string
  current: WorkspaceSubdomain | null
  onChanged: () => void
}) {
  // A Team feature: the server 402s an unentitled claim, so a Free workspace sees the
  // upgrade link where the form would be. Until billing answers, the form waits.
  const { data: billing } = useQuery(billingQuery())
  const locked = billing ? !billing.custom_domain : false
  const [editing, setEditing] = useState(false)

  return (
    <SettingsGroup
      title="Workspace subdomain"
      description={`One name, on ${base}. It works the moment you claim it: no DNS, no certificate to wait for. Shared pages keep their derive.to link too.`}
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
  const [label, setLabel] = useState(initial)
  const valid = LABEL.test(label)
  const claim = useApiMutation({
    mutationFn: (l: string) => api.claimWorkspaceSubdomain(l),
    success: "Subdomain claimed. Your shared pages are live there now.",
    onSuccess: onDone,
  })
  return (
    <AddForm
      onSubmit={() => valid && claim.mutate(label)}
      submitLabel={initial ? "Change" : "Claim"}
      submitTestId="subdomain-claim"
      pending={claim.isPending}
      disabled={!ready || !valid || label === initial}
      after={
        <>
          {/* The format, live: the link a reader would get, updated as the label is
              typed. Mono, quiet, one line; the sample ref keeps the shape honest. */}
          <p
            data-testid="subdomain-preview"
            className="truncate font-mono text-2xs text-muted-foreground"
          >
            {label ? (
              <>
                Your links will read{" "}
                <span className="text-foreground">
                  https://{label}.{base}/
                </span>
                <span>{SAMPLE_REF}</span>
              </>
            ) : (
              <>
                Your links will read https://<span className="text-foreground">name</span>.{base}/
                {SAMPLE_REF}
              </>
            )}
          </p>
          {label && !valid && (
            <p className="text-2xs text-destructive">
              Letters, numbers and hyphens only, and it can't start or end with a hyphen.
            </p>
          )}
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
      <div className="flex min-w-60 flex-1 items-center rounded-md border bg-background pr-3 focus-within:ring-1 focus-within:ring-ring">
        <Input
          data-testid="subdomain-label"
          aria-label="Subdomain name"
          value={label}
          onChange={(e) => setLabel(normalizeLabel(e.target.value))}
          placeholder="acme"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="border-0 bg-transparent font-mono shadow-none focus-visible:ring-0"
        />
        <span className="shrink-0 select-none font-mono text-sm text-muted-foreground">
          .{base}
        </span>
      </div>
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
      meta={
        <span className="font-mono">
          Every shared artifact is also at {current.url}/{"<artifact-id>"}
        </span>
      }
      actions={
        <>
          <StatusBadge data-testid="subdomain-status" tone="ok">
            Live
          </StatusBadge>
          <Button
            variant="ghost"
            size="sm"
            data-testid="subdomain-copy"
            aria-label="Copy the subdomain"
            onClick={() => void copy(current.url, { success: "Copied" })}
          >
            {copied ? <Icon name="check" className="text-success" /> : <Copy className="size-4" />}
            Copy
          </Button>
          {/* A lapsed plan keeps what it has but can't pick a new name. */}
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
          {/* The format, as it stands: one real-shaped example of the link readers get. */}
          <div className="rounded-lg bg-secondary px-3 py-2">
            <p className="mb-1 font-mono text-2xs text-muted-foreground">
              A shared artifact's link reads:
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

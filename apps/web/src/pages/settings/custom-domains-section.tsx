import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, type WorkspaceDomain } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { EmptyState } from "@/components/shared/empty-state"
import { SettingsGroup } from "@/components/shared/settings-group"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { customDomainsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

export function CustomDomainsSection() {
  const qc = useQueryClient()
  const { data: state, isPending } = useQuery(customDomainsQuery())
  const reload = () => qc.invalidateQueries({ queryKey: customDomainsQuery().queryKey })

  const description =
    "Put your own domain on this workspace. Every artifact is then served at your-domain/<id>. Cloudflare for SaaS issues and renews the TLS cert."

  if (isPending)
    return (
      <SettingsSection title="Domains" description={description}>
        <SettingsListSkeleton />
      </SettingsSection>
    )

  if (!state?.enabled)
    return (
      <SettingsSection title="Domains" description={description}>
        <EmptyState>Custom domains aren't enabled on this server.</EmptyState>
      </SettingsSection>
    )

  return (
    <SettingsSection title="Domains" description={description}>
      <NewDomain cnameTarget={state.cname_target} onCreated={reload} />

      {state.domains.length === 0 ? (
        <EmptyState>No custom domains yet. Add one above.</EmptyState>
      ) : (
        <SettingsGroup>
          {state.domains.map((d) => (
            <DomainRow key={d.host} domain={d} onChanged={reload} />
          ))}
        </SettingsGroup>
      )}
    </SettingsSection>
  )
}

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
    success: "Domain added — add the DNS records to finish",
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
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          data-testid="domain-host"
          aria-label="Custom domain"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="docs.acme.com"
          className="min-w-60 flex-1 font-mono"
        />
        <Button
          data-testid="domain-add"
          variant="secondary"
          size="sm"
          onClick={add}
          loading={addDomain.isPending}
          disabled={addDomain.isPending || !host.trim()}
        >
          {addDomain.isPending ? "Adding…" : "Add"}
        </Button>
      </div>
      {cnameTarget && (
        <p className="font-mono text-2xs text-muted-foreground">
          CNAME your domain to <span className="text-foreground">{cnameTarget}</span>.
        </p>
      )}
    </div>
  )
}

// Verification state → badge tone: a live cert is a success, a failed issuance is
// destructive, and pending means DNS work is still on the user (warning, not the accent).
const statusBadge = (
  s: string,
): { variant: "success" | "destructive" | "warning"; label: string } =>
  s === "active"
    ? { variant: "success", label: "Active" }
    : s === "error"
      ? { variant: "destructive", label: "Error" }
      : { variant: "warning", label: "Pending" }

function DomainRow({ domain, onChanged }: { domain: WorkspaceDomain; onChanged: () => void }) {
  const b = statusBadge(domain.status)
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
    <div data-testid={`domain-row-${domain.host}`} className="flex flex-col gap-2 py-3">
      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
          {domain.host}
        </div>
        <Badge data-testid="domain-status" variant={b.variant}>
          {b.label}
        </Badge>
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
      </div>
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
    </div>
  )
}

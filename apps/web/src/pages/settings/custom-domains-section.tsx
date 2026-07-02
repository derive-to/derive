import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { api, type WorkspaceDomain } from "@/api"
import { EmptyState } from "@/components/shared/empty-state"
import { Spinner } from "@/components/shared/spinner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

type State = { enabled: boolean; cname_target: string | null; domains: WorkspaceDomain[] }

export function CustomDomainsSection() {
  const [state, setState] = useState<State | null>(null)
  const load = useCallback(
    () =>
      api
        .listWorkspaceDomains()
        .then(setState)
        .catch(() => setState({ enabled: false, cname_target: null, domains: [] })),
    [],
  )
  useEffect(() => {
    load()
  }, [load])

  if (state === null)
    return (
      <div className="flex h-20 items-center justify-center">
        <Spinner />
      </div>
    )

  if (!state.enabled)
    return (
      <section>
        <EmptyState>Custom domains aren't enabled on this server.</EmptyState>
      </section>
    )

  return (
    <section>
      <p className="mb-4 text-sm text-muted-foreground">
        Put your own domain on this workspace. Every artifact is then served at{" "}
        <code className="font-mono">your-domain/&lt;id&gt;</code>. Cloudflare for SaaS issues and
        renews the TLS cert.
      </p>

      <NewDomain cnameTarget={state.cname_target} onCreated={load} />

      <div className="mt-4 flex flex-col gap-2.5">
        {state.domains.length === 0 ? (
          <EmptyState>No custom domains yet. Add one above.</EmptyState>
        ) : (
          state.domains.map((d) => <DomainRow key={d.host} domain={d} onChanged={load} />)
        )}
      </div>
    </section>
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
  const [busy, setBusy] = useState(false)
  const add = async () => {
    const h = host.trim()
    if (!h) return
    setBusy(true)
    try {
      await api.addWorkspaceDomain(h)
      setHost("")
      toast.success("Domain added — add the DNS records to finish")
      onCreated()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="gap-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          data-testid="domain-host"
          aria-label="Custom domain"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="docs.acme.com"
          className="min-w-[240px] flex-1 font-mono"
        />
        <Button
          data-testid="domain-add"
          variant="secondary"
          size="sm"
          onClick={add}
          disabled={busy || !host.trim()}
        >
          {busy ? "Adding…" : "Add"}
        </Button>
      </div>
      {cnameTarget && (
        <p className="font-mono text-2xs text-muted-foreground">
          CNAME your domain to <span className="text-foreground">{cnameTarget}</span>.
        </p>
      )}
    </Card>
  )
}

// Verification state → badge tone: a live cert is a success, a failed issuance is
// destructive, and pending means DNS work is still on the user (warning, not amber).
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
  const refresh = async () => {
    try {
      await api.refreshWorkspaceDomain(domain.host)
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const remove = async () => {
    try {
      await api.removeWorkspaceDomain(domain.host)
      toast.success("Domain removed")
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  return (
    <Card data-testid={`domain-row-${domain.host}`} className="gap-0 overflow-hidden p-0">
      <div className="flex items-center gap-2.5 px-3.5 py-3">
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
          variant="ghost"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          size="sm"
          onClick={remove}
        >
          Remove
        </Button>
      </div>
      {domain.status !== "active" && domain.records && domain.records.length > 0 && (
        <div className="border-t border-border-soft bg-secondary px-3.5 py-2">
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
    </Card>
  )
}

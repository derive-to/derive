import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { Skeleton } from "@/components/ui/skeleton"
import { useDocumentTitle } from "@/lib/use-document-title"
import { BrandprintSection } from "./brandprint-section"

// The Brandprint page: /brandprint — the workspace's conventions and your personal
// layer, one destination in the rail (a peer of Contexts). Promoted out of Settings:
// a Brandprint is something a team sets up and returns to, not a preference. The two
// sections own their data, states, and writes; this page is composition only.
export function Brandprint() {
  useDocumentTitle("Brandprint")
  return (
    <PageShell className="flex flex-col gap-8">
      <PageHeader
        title="Brandprint"
        subtitle="The conventions your artifacts follow — how they look and how they read. Any agent connected to this workspace picks them up automatically."
      />
      <BrandprintSection scope="workspace" />
      <BrandprintSection scope="account" />
    </PageShell>
  )
}

// Deterministic silhouette: the header band, then two group-shaped blocks (title
// line, description line, a row) matching the sections above.
const PENDING_GROUPS = ["workspace", "account"]

export function BrandprintPending() {
  return (
    <PageShell className="flex flex-col gap-8" aria-busy>
      <span role="status" className="sr-only">
        Loading Brandprint…
      </span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-3/4" />
      </div>
      {PENDING_GROUPS.map((k) => (
        <div key={k} className="flex flex-col gap-3">
          <Skeleton className="h-5 w-52" />
          <Skeleton className="h-4 w-2/3" />
          <div className="flex items-center justify-between py-3.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-8 w-36" />
          </div>
        </div>
      ))}
    </PageShell>
  )
}

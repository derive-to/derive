import { useEffect, useState } from "react"
import { api, type InstallationRepo, type SyncPreview } from "@/api"
import { EmptyState } from "@/components/shared/empty-state"
import { SearchField } from "@/components/shared/search-field"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { toast } from "@/components/ui/sonner"
import { ago } from "@/lib/time"
import { useApiMutation } from "@/lib/use-api-mutation"
import { SettingsListSkeleton } from "./settings-list-skeleton"

// Build the include-globs string from the content-type toggle + optional folder.
const buildIncludes = (md: boolean, html: boolean, folder: string): string => {
  const exts = [...(md ? ["md"] : []), ...(html ? ["html"] : [])]
  if (exts.length === 0) return ""
  const dir = folder.trim().replace(/^\/+|\/+$/g, "")
  const prefix = dir ? `${dir}/**/` : "**/"
  return exts.map((e) => `${prefix}*.${e}`).join(",")
}

// The repo picker: choose ONE repo, scope what to mirror (type + folder), see a
// live count, then connect. Sync runs afterward in the row (with progress).
export function RepoPicker({
  installationId,
  onClose,
  onConnected,
}: {
  installationId: string
  onClose: () => void
  onConnected: () => void
}) {
  const [repos, setRepos] = useState<InstallationRepo[] | null>(null)
  const [repo, setRepo] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [md, setMd] = useState(true)
  const [html, setHtml] = useState(true)
  const [folder, setFolder] = useState("")
  const [preview, setPreview] = useState<SyncPreview | "loading" | null>(null)
  const includes = buildIncludes(md, html, folder)

  useEffect(() => {
    api
      .listInstallationRepos(installationId)
      .then((r) => setRepos(r.repos))
      .catch((e) => {
        // Loading the installation's repo list is a read, not a mutation; surface a
        // failure so the empty state below isn't misread as "no repos".
        toast.error((e as Error).message) // mutation-ignore: repo-list load error, not a mutation
        setRepos([])
      })
  }, [installationId])

  // Filter the (already most-recent-first) list by a case-insensitive substring.
  const q = query.trim().toLowerCase()
  const shown = repos?.filter((r) => !q || r.full_name.toLowerCase().includes(q)) ?? null

  // Live preview count, debounced on repo/scope change.
  useEffect(() => {
    if (!repo || !includes) {
      setPreview(null)
      return
    }
    setPreview("loading")
    const t = setTimeout(() => {
      api
        .previewRepo(installationId, repo, includes)
        .then((p) => setPreview(p))
        .catch(() => setPreview(null))
    }, 350)
    return () => clearTimeout(t)
  }, [installationId, repo, includes])

  const connect = useApiMutation({
    // Connect only — the row auto-syncs in batches with a progress bar.
    mutationFn: (repoName: string) =>
      api.connectRepoSource({ repo: repoName, installation_id: installationId, includes }),
    success: "Repository connected. Syncing now.",
    onSuccess: () => onConnected(),
  })
  const doConnect = () => {
    if (repo && includes) connect.mutate(repo)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mirror a repository</DialogTitle>
          <DialogDescription>
            Pick a repo and what to pull in. GitHub stays the source of truth.
          </DialogDescription>
        </DialogHeader>

        {repos && repos.length > 0 && (
          <SearchField
            value={query}
            onValueChange={setQuery}
            placeholder="Filter repositories…"
            aria-label="Filter repositories"
            testId="github-repo-search"
            autoFocus
            className="mb-2"
          />
        )}

        <div className="max-h-[34vh] overflow-y-auto">
          {repos === null ? (
            <SettingsListSkeleton />
          ) : repos.length === 0 ? (
            <EmptyState>This installation has no repositories Derive can read.</EmptyState>
          ) : shown && shown.length === 0 ? (
            <EmptyState>No repositories match “{query.trim()}”.</EmptyState>
          ) : (
            <RadioGroup value={repo ?? ""} onValueChange={setRepo} className="gap-1">
              {shown?.map((r) => (
                <label
                  key={r.full_name}
                  className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-secondary"
                >
                  <RadioGroupItem value={r.full_name} data-testid="github-repo-radio" />
                  <span className="font-mono text-xs text-foreground">{r.full_name}</span>
                  {r.private && <Eyebrow>private</Eyebrow>}
                  {r.pushed_at && (
                    <span className="ml-auto shrink-0 font-mono text-2xs text-muted-foreground">
                      {ago(r.pushed_at)}
                    </span>
                  )}
                </label>
              ))}
            </RadioGroup>
          )}
        </div>

        {repo && (
          <div className="mt-1 flex flex-col gap-2.5 border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium text-muted-foreground">Include:</span>
              <label className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  data-testid="github-include-md"
                  checked={md}
                  onCheckedChange={(v) => setMd(v === true)}
                />{" "}
                Markdown
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  data-testid="github-include-html"
                  checked={html}
                  onCheckedChange={(v) => setHtml(v === true)}
                />{" "}
                HTML
              </label>
            </div>
            <Input
              aria-label="Folder to scope to"
              data-testid="github-folder"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="Folder (optional, for example docs). Leave blank for the whole repo."
              className="font-mono"
            />
            <div className="text-sm text-muted-foreground" data-testid="github-preview">
              {!includes ? (
                <span className="text-destructive">Pick at least one file type.</span>
              ) : preview === "loading" ? (
                "Counting…"
              ) : preview ? (
                <>
                  <span className="font-mono font-medium tabular-nums text-foreground">
                    {preview.total} file{preview.total === 1 ? "" : "s"}
                  </span>{" "}
                  · {preview.md} MD · {preview.html} HTML
                  {preview.truncated && " · (repo is large; some files not counted)"}
                </>
              ) : (
                " "
              )}
            </div>
          </div>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <Button
            variant="ghost"
            data-testid="github-cancel"
            onClick={onClose}
            disabled={connect.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={doConnect}
            loading={connect.isPending}
            disabled={connect.isPending || !repo || !includes}
            data-testid="github-picker-connect"
          >
            {connect.isPending ? "Connecting…" : "Connect & sync"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

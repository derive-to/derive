import { useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useState } from "react"
import { api, type GithubSyncStatus } from "@/api"
import { EmptyState } from "@/components/shared/empty-state"
import { SettingsGroup } from "@/components/shared/settings-group"
import { toast } from "@/components/ui/sonner"
import { AdvancedPat } from "./github-advanced-pat"
import { ConnectViaApp, SetUpApp, takeInstallParams } from "./github-install-flow"
import { PrPreviewRow } from "./github-pr-preview"
import { RepoPicker } from "./github-repo-picker"
import { RepoSourceRow } from "./github-repo-row"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

// Open the repo picker automatically the first time a configured + installed
// workspace lands here without a repo connected yet (once per browser session), so
// connecting is one step instead of "find the account button, then pick". Stops once
// any repo is connected.
const AUTO_PICKER_KEY = "derive:gh-auto-picker"

export function GithubSection() {
  const qc = useQueryClient()
  const [status, setStatus] = useState<GithubSyncStatus | null>(null)
  const [pickerInstall, setPickerInstall] = useState<string | null>(null)

  const load = useCallback(
    () =>
      api
        .githubSync()
        .then(setStatus)
        .catch(() =>
          setStatus({ sources: [], prs: [], app: { configured: false }, installations: [] }),
        ),
    [],
  )
  // After a sync/connect, the mirrored collection changed → drop the library's
  // artifact caches so a freshly-populated collection isn't shown stale/empty.
  const refresh = useCallback(() => {
    load()
    qc.invalidateQueries({ queryKey: ["artifacts"] })
  }, [load, qc])
  useEffect(() => {
    load()
  }, [load])

  // After the GitHub redirect (?gh_install / ?gh_error), open the picker or toast.
  useEffect(() => {
    const { install, error } = takeInstallParams()
    if (error) toast.error(error === "install_expired" ? "Install link expired" : "Install failed")
    if (install) setPickerInstall(install)
  }, [])

  // Onboarding shortcut: an App is configured and installed but no repo is connected
  // yet → open the picker for the first installation so the user goes straight to
  // choosing a repo. Once per session (so a return visit isn't hijacked) and never
  // once a repo exists or the redirect already opened a picker.
  useEffect(() => {
    if (!status?.app.configured || pickerInstall || status.sources.length > 0) return
    const first = status.installations[0]
    if (!first || sessionStorage.getItem(AUTO_PICKER_KEY)) return
    sessionStorage.setItem(AUTO_PICKER_KEY, "1")
    setPickerInstall(first.installation_id)
  }, [status, pickerInstall])

  const appConfigured = status?.app.configured ?? false

  return (
    <SettingsSection
      title="GitHub"
      description="Mirror a GitHub repo's Markdown and HTML into a collection. Sync is one-way: GitHub stays the source of truth, so synced docs are read-only here but stay fully commentable."
    >
      {status === null ? (
        <SettingsListSkeleton />
      ) : appConfigured ? (
        <ConnectViaApp
          status={status}
          onPick={setPickerInstall}
          onError={(m) => toast.error(m)}
          onRefresh={load}
        />
      ) : (
        <SetUpApp />
      )}

      {/* Rendered only once status is known. */}
      {status !== null &&
        (status.sources.length === 0 ? (
          <EmptyState>No repos connected yet. Add one above.</EmptyState>
        ) : (
          <SettingsGroup title="Mirrored repositories">
            {status.sources.map((s) => (
              <RepoSourceRow
                key={s.id}
                source={s}
                onChanged={(m) => {
                  toast.success(m)
                  refresh()
                }}
                onError={(m) => toast.error(m)}
              />
            ))}
          </SettingsGroup>
        ))}

      {/* PR previews — read-only mirrors of the docs an OPEN pull request changes,
          each in its own "PR #<n>" collection. Created automatically as PRs open; they
          disappear when the PR closes/merges. Review the plan in Derive during the PR. */}
      {status !== null && status.prs.length > 0 && (
        <SettingsGroup
          title="Pull request previews"
          description="Open PRs that change docs appear here while they're open. Review them in Derive; on merge they fold into the collection above."
        >
          {status.prs.map((pr) => (
            <PrPreviewRow key={pr.id} pr={pr} />
          ))}
        </SettingsGroup>
      )}

      {/* The PAT path stays available as an advanced fallback (self-host without a
          GitHub App, or a one-off public repo). */}
      <AdvancedPat
        onCreated={() => {
          toast.success("Repo connected — syncing")
          refresh()
        }}
        onError={(m) => toast.error(m)}
      />

      {pickerInstall && (
        <RepoPicker
          installationId={pickerInstall}
          onClose={() => setPickerInstall(null)}
          onConnected={() => {
            setPickerInstall(null)
            toast.success("Repo connected — syncing")
            refresh()
          }}
          onError={(m) => toast.error(m)}
        />
      )}
    </SettingsSection>
  )
}

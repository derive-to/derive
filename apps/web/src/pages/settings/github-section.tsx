import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { api, type GithubSyncStatus } from "@/api"
import { LoadError } from "@/components/shared/load-error"
import { SettingsEmpty } from "@/components/shared/settings-empty"
import { SettingsGroup } from "@/components/shared/settings-group"
import { toast } from "@/components/ui/sonner"
import { useOneShotParams } from "@/lib/use-one-shot-params"
import { AdvancedPat } from "./github-advanced-pat"
import { ConnectViaApp, SetUpApp } from "./github-install-flow"
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
  const [loadError, setLoadError] = useState(false)
  const [pickerInstall, setPickerInstall] = useState<string | null>(null)

  // A failed status load used to fake `configured:false` — which renders the "Set up GitHub
  // App" screen as if nothing were connected. Track the error instead and offer a retry, so a
  // transient blip doesn't read as "your integration is gone".
  const load = () =>
    api
      .githubSync()
      .then((s) => {
        setStatus(s)
        setLoadError(false)
      })
      .catch(() => setLoadError(true))
  // After a sync/connect, the mirrored collection changed → drop the library's
  // artifact caches so a freshly-populated collection isn't shown stale/empty.
  const refresh = () => {
    load()
    qc.invalidateQueries({ queryKey: ["artifacts"] })
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetch the GitHub status once on mount; load is stable (reads only api + setStatus).
  useEffect(() => {
    load()
  }, [])

  // After the GitHub redirect (?gh_install / ?gh_error), open the picker or toast.
  const { gh_install: ghInstall, gh_error: ghError } = useOneShotParams("gh_install", "gh_error")
  useEffect(() => {
    if (ghError)
      toast.error(ghError === "install_expired" ? "Install link expired" : "Install failed") // mutation-ignore: OAuth ?gh_error redirect param, not a mutation
    if (ghInstall) setPickerInstall(ghInstall)
  }, [ghInstall, ghError])

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
      description="Sync a GitHub repository's Markdown and HTML into a collection. GitHub remains the source, so the documents are read-only in Derive but still support comments."
    >
      {status === null ? (
        loadError ? (
          <LoadError
            layout="inline"
            title="Couldn’t load your GitHub status"
            testId="github-retry"
            onRetry={load}
          />
        ) : (
          <SettingsListSkeleton />
        )
      ) : appConfigured ? (
        <ConnectViaApp status={status} onPick={setPickerInstall} onRefresh={load} />
      ) : (
        <SetUpApp />
      )}

      {/* Rendered only once status is known. Before the App exists, the setup
          card above is the whole story — a "no repos yet" line under it would
          point at a step that isn't available yet. */}
      {status !== null &&
        (status.sources.length === 0 ? (
          appConfigured && (
            <SettingsEmpty>
              No repositories mirrored yet. Install the app above, then choose a repository.
            </SettingsEmpty>
          )
        ) : (
          <SettingsGroup title="Mirrored repositories">
            {status.sources.map((s) => (
              <RepoSourceRow key={s.id} source={s} onDone={refresh} />
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
      <AdvancedPat onCreated={refresh} />

      {pickerInstall && (
        <RepoPicker
          installationId={pickerInstall}
          onClose={() => setPickerInstall(null)}
          onConnected={() => {
            setPickerInstall(null)
            refresh()
          }}
        />
      )}
    </SettingsSection>
  )
}

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Upload } from "lucide-react"
import { useRef, useState } from "react"
import { api, type OrgSettings } from "@/api"
import { Icon } from "@/components/icons"
import { SettingRow } from "@/components/shared/setting-row"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  SelectMenu,
  SelectMenuContent,
  SelectMenuItem,
  SelectMenuTrigger,
} from "@/components/ui/select-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/ctx"
import {
  brandprintDocsQuery,
  collectionsQuery,
  workspaceQuery,
  workspaceSettingsQuery,
  workspaceSkillsQuery,
} from "@/lib/queries"
import { snapshot, useApiMutation } from "@/lib/use-api-mutation"
import { refFor } from "../artifact/parse-ref"
import { nextPersonalBrandprint } from "./personal-brandprint"
import {
  ensureProfilePlaceholder,
  type ImportResult,
  notesAsDoc,
  useBrandprintImport,
} from "./use-brandprint-import"

// The two halves of a brand the upload tab asks for; `cat` labels each staged file
// and doubles as the verb in the well's heading ("How … artifacts should look/read").
type DocCategory = "look" | "read"
const UPLOAD_CATEGORIES: { cat: DocCategory; blurb: string }[] = [
  {
    cat: "look",
    blurb:
      "Visual theming: brand and style guides, palettes, font specs, CSS tokens, or example HTML that carries the look.",
  },
  {
    cat: "read",
    blurb: "Voice and tone: grammar, warmth, structure, wording do’s and don’ts.",
  },
]

const DOC_FILE_TYPES = ".md,.markdown,.txt,.html,.htm,.css"

// The intake's hidden file input — one recipe for its two surfaces (the set-state
// row and the create dialog's upload tab, never mounted together), so the accept
// list and the value reset that lets the same file be re-picked can't drift apart.
function DocFileInput({
  inputRef,
  scope,
  onPick,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  scope: "workspace" | "account"
  onPick: (files: FileList | null) => void
}) {
  return (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept={DOC_FILE_TYPES}
      className="hidden"
      data-testid={`brandprint-upload-input-${scope}`}
      onChange={(e) => {
        onPick(e.target.files)
        e.target.value = ""
      }}
    />
  )
}

/**
 * Point this scope's Brandprint at a conventions collection — the docs/skills that
 * describe how artifacts should be built here. An agent connected over MCP resolves
 * workspace ⊕ account (account wins) and reads those docs as Brandprint context.
 * Workspace scope saves to the workspace settings (Admin only, like the workspace
 * defaults in Settings → General); account scope saves to your own profile. Clearing
 * sets the pointer back to none. The generated brand profile has its own home (the
 * panel on this page); here it only means workspace pointer-writes seed its placeholder.
 *
 * Setup happens in place: an empty scope shows one "Create Brandprint" button whose
 * dialog offers three ways in (upload files, write the conventions from scratch, or
 * point at an existing collection) — so nobody has to publish from the library,
 * build a collection by hand, and come back here to select it. Once set, the section
 * shows the pointer and takes more docs directly.
 */
export function BrandprintSection({ scope }: { scope: "workspace" | "account" }) {
  const qc = useQueryClient()
  const { me, setMe } = useAuth()
  const {
    data: collections,
    isError: collectionsError,
    refetch: refetchCollections,
  } = useQuery(collectionsQuery())
  // Shared cache entry with Settings → General (staleTime Infinity), so this page
  // and that section never double-fetch the same workspace record.
  const { data: ws } = useQuery({ ...workspaceQuery(), enabled: scope === "workspace" })
  const {
    data: settings,
    isError: settingsError,
    refetch: refetchSettings,
  } = useQuery({
    ...workspaceSettingsQuery(),
    enabled: scope === "workspace",
  })

  const collectionId =
    scope === "workspace"
      ? (settings?.brandprint?.collectionId ?? "")
      : (me?.brandprint?.collectionId ?? "")
  // The workspace's brand-profile pointer. The settings query is disabled on account
  // scope, so this is always undefined there — no scope branch needed.
  const profileId = settings?.brandprint?.profileId ?? undefined

  const updateWorkspace = useApiMutation({
    // Any workspace pointer-write also seeds the brand-profile placeholder when one is
    // missing, so the hand-off beat always has an address to propose against — whether
    // the collection came from the main picker or the dialog's "Use a collection" tab.
    // Best-effort: a placeholder failure still sets the pointer; a later write heals it.
    // The generated OrgSettings types brandprint non-nullable, but the PATCH takes null to
    // clear it — widen to Partial so the clear case type-checks.
    mutationFn: async (collectionId: string) => {
      const seeded =
        collectionId && !profileId
          ? await ensureProfilePlaceholder(collectionId).catch(() => undefined)
          : undefined
      return api.updateWorkspaceSettings({
        brandprint: collectionId
          ? { collectionId, ...(seeded ? { profileId: seeded } : {}) }
          : null,
      } as Partial<OrgSettings>)
    },
    optimistic: (collectionId, client) => {
      const qk = workspaceSettingsQuery().queryKey
      const rollback = snapshot(client, qk)
      client.setQueryData(qk, (prev) =>
        prev
          ? {
              ...prev,
              brandprint: collectionId ? { ...prev.brandprint, collectionId } : undefined,
            }
          : prev,
      )
      return rollback
    },
    onSuccess: (s) => qc.setQueryData(workspaceSettingsQuery().queryKey, s),
    success: "Brandprint updated",
  })
  const updateAccount = useApiMutation({
    // A save must never drop a field it isn't changing. `setProfile` replaces the
    // whole personal Brandprint object, so this merges into the current one instead
    // of sending `collectionId` bare (that would silently clear the workspace toggle
    // below on every collection save, and clearing the collection would clear the
    // toggle too). nextPersonalBrandprint collapses to null only once nothing is left.
    mutationFn: (collectionId: string) =>
      api.setProfile({
        brandprint: nextPersonalBrandprint(me?.brandprint, {
          collectionId: collectionId || undefined,
        }),
      }),
    onSuccess: (r) => {
      if (me) setMe({ ...me, brandprint: r.brandprint })
    },
    success: "Brandprint updated",
  })
  // The personal "use workspace Brandprint" switch: off suppresses the workspace
  // layer for this user while their own personal collection (above) still applies.
  // Same merge-preserving save and setMe mirroring as updateAccount, just patching
  // the toggle field instead of the collection pointer.
  const toggleWorkspace = useApiMutation({
    mutationFn: (on: boolean) =>
      api.setProfile({
        brandprint: nextPersonalBrandprint(me?.brandprint, {
          // Write undefined (not true) so "on" stores nothing: absent means on.
          useWorkspaceBrandprint: on ? undefined : false,
        }),
      }),
    onSuccess: (r) => {
      if (me) setMe({ ...me, brandprint: r.brandprint })
    },
    success: "Brandprint updated",
  })
  // The one-click intake, shared with onboarding's Brandprint step — see
  // use-brandprint-import for the composition and its failure semantics.
  const fileRef = useRef<HTMLInputElement>(null)
  const importDocs = useBrandprintImport(scope, collectionId, profileId)
  const pickFiles = (list: FileList | null) => {
    const files = list ? [...list] : []
    if (files.length > 0) importDocs.mutate(files)
  }

  // The create dialog (empty state only): three ways in — upload files (default),
  // write the conventions from scratch, or point at an existing collection.
  const [createOpen, setCreateOpen] = useState(false)
  const [noteTitle, setNoteTitle] = useState("")
  const [notes, setNotes] = useState("")
  // The upload tab STAGES picks instead of firing per pick: files arrive from two
  // category pickers (look / read), and the first mutation would set the pointer,
  // flip the section out of its empty state, and unmount the dialog under the
  // second picker. One batch, one create.
  const [staged, setStaged] = useState<{ id: number; file: File; cat: DocCategory }[]>([])
  const stageCat = useRef<DocCategory>("look")
  // Monotonic row ids — names can repeat across picks, so they can't key the list.
  const stagedSeq = useRef(0)
  const stageFiles = (list: FileList | null) => {
    const files = list ? [...list] : []
    const cat = stageCat.current
    if (files.length > 0)
      setStaged((prev) => [
        ...prev,
        ...files.map((file) => ({ id: stagedSeq.current++, file, cat })),
      ])
  }
  // Close on a successful create; a total failure keeps the dialog up to retry from.
  const closeOnSuccess = (r: ImportResult) => {
    if (r.ok > 0) {
      setCreateOpen(false)
      setStaged([])
      setNotes("")
      setNoteTitle("")
    }
  }
  const createFromStaged = () => {
    if (staged.length === 0) return
    importDocs.mutate(
      staged.map((s) => s.file),
      { onSuccess: closeOnSuccess },
    )
  }
  const createFromNotes = () => {
    const text = notes.trim()
    if (!text) return
    importDocs.mutate([notesAsDoc(text, noteTitle)], { onSuccess: closeOnSuccess })
  }

  const title = scope === "workspace" ? "Workspace Brandprint" : "Your Brandprint"
  const description =
    scope === "workspace"
      ? "Your team's design and voice conventions: the visual style, tone, and structure your work should follow. Agents read these docs before building anything in this workspace, so everything they produce stays on brand."
      : "Your personal conventions, layered over the workspace's when an agent acts as you (yours wins)."

  if (scope === "account" && !me) return null

  // A failed read leaves the picker unable to show its current value (workspace scope)
  // or its options (both) — surface it with a retry rather than degrade to a silent
  // "None", mirroring the sibling sections (General's SharingDefaults reads this same
  // workspace-settings query the same way). The disabled workspace-settings query on
  // the account scope never errors, so account scope only reacts to a collections failure.
  const loadError = collectionsError || (scope === "workspace" && settingsError)
  const retry = () => {
    refetchCollections()
    if (scope === "workspace") refetchSettings()
  }
  if (loadError)
    return (
      <SettingsGroup title={title} description={description}>
        <StatusPanel
          layout="inline"
          tone="danger"
          title="Couldn't load your Brandprint"
          description="This is usually temporary."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid={`brandprint-retry-${scope}`}
              onClick={retry}
            >
              Try again
            </Button>
          }
        />
      </SettingsGroup>
    )

  const isAdmin = ws?.role === "owner"
  const ready = scope === "workspace" ? !!settings : true
  const disabled =
    !ready ||
    importDocs.isPending ||
    (scope === "workspace"
      ? !isAdmin || updateWorkspace.isPending
      : updateAccount.isPending || toggleWorkspace.isPending)
  const save = (next: string) =>
    scope === "workspace" ? updateWorkspace.mutate(next) : updateAccount.mutate(next)
  const selected = collections?.find((c) => c.id === collectionId)?.title

  return (
    <SettingsGroup title={title} description={description}>
      {!ready || collectionId ? (
        <>
          <SettingRow label="Conventions collection">
            <SelectMenu value={collectionId} onValueChange={save}>
              <SelectMenuTrigger
                aria-label="Conventions collection"
                data-testid={`brandprint-collection-${scope}`}
                disabled={disabled}
              >
                {!ready ? "Loading…" : (selected ?? "…")}
              </SelectMenuTrigger>
              <SelectMenuContent>
                <SelectMenuItem value="">None</SelectMenuItem>
                {(collections ?? []).map((c) => (
                  <SelectMenuItem key={c.id} value={c.id}>
                    {c.title}
                  </SelectMenuItem>
                ))}
              </SelectMenuContent>
            </SelectMenu>
          </SettingRow>
          <SettingRow
            label="Upload documents"
            description="More look or read docs publish straight into this Brandprint's collection."
          >
            <DocFileInput inputRef={fileRef} scope={scope} onPick={pickFiles} />
            <Button
              variant="outline"
              size="sm"
              data-testid={`brandprint-upload-${scope}`}
              disabled={disabled}
              loading={importDocs.isPending}
              onClick={() => fileRef.current?.click()}
            >
              <Upload /> {importDocs.isPending ? "Uploading…" : "Upload docs"}
            </Button>
          </SettingRow>
          {collectionId && (
            <SettingRow
              label="Add a skill"
              description="Put a published skill (how agents build things) into this Brandprint."
            >
              <AddSkill collectionId={collectionId} scope={scope} disabled={disabled} />
            </SettingRow>
          )}
          {collectionId && (
            <BrandprintDocs
              collectionId={collectionId}
              scope={scope}
              disabled={disabled}
              profileId={profileId}
            />
          )}
        </>
      ) : (
        <SettingRow
          label="Get started"
          description="Upload files for how your work should look and read, write your conventions from scratch, or use an existing collection."
        >
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm" data-testid={`brandprint-create-${scope}`} disabled={disabled}>
                Create Brandprint
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
              <DialogHeader>
                <DialogTitle>Create your Brandprint</DialogTitle>
              </DialogHeader>
              <Tabs defaultValue="upload">
                <TabsList variant="line">
                  <TabsTrigger value="upload" data-testid={`brandprint-tab-upload-${scope}`}>
                    Upload files
                  </TabsTrigger>
                  <TabsTrigger value="write" data-testid={`brandprint-tab-write-${scope}`}>
                    Write it
                  </TabsTrigger>
                  <TabsTrigger value="existing" data-testid={`brandprint-tab-existing-${scope}`}>
                    Use a collection
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="upload" className="flex flex-col gap-3 pt-3">
                  <p className="text-sm text-pretty text-muted-foreground">
                    Give it both sides of the brand, or start with one. Derive publishes the files,
                    gathers them into a new collection, and points your Brandprint at it.
                  </p>
                  <DocFileInput inputRef={fileRef} scope={scope} onPick={stageFiles} />
                  {UPLOAD_CATEGORIES.map((c) => (
                    <div
                      key={c.cat}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-secondary/40 px-4 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground">
                          How {scope === "workspace" ? "your team's" : "your"} artifacts should{" "}
                          {c.cat}
                        </p>
                        <p className="text-sm text-pretty text-muted-foreground">{c.blurb}</p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid={`brandprint-upload-${c.cat}-${scope}`}
                        disabled={importDocs.isPending}
                        onClick={() => {
                          stageCat.current = c.cat
                          fileRef.current?.click()
                        }}
                      >
                        <Upload /> Choose files
                      </Button>
                    </div>
                  ))}
                  {staged.length > 0 && (
                    <ul className="flex flex-col gap-1">
                      {staged.map((s) => (
                        <li key={s.id} className="flex items-center gap-2 text-sm">
                          <Badge variant="secondary" shape="pill">
                            {s.cat === "look" ? "Look" : "Read"}
                          </Badge>
                          <span className="min-w-0 flex-1 truncate text-foreground">
                            {s.file.name}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Remove ${s.file.name}`}
                            data-testid="brandprint-staged-remove"
                            onClick={() => setStaged((prev) => prev.filter((x) => x.id !== s.id))}
                          >
                            <Icon name="close" size={14} />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <Button
                    className="self-end"
                    data-testid={`brandprint-upload-create-${scope}`}
                    loading={importDocs.isPending}
                    disabled={importDocs.isPending || staged.length === 0}
                    onClick={createFromStaged}
                  >
                    {importDocs.isPending ? "Creating…" : "Create Brandprint"}
                  </Button>
                </TabsContent>
                <TabsContent value="write" className="flex flex-col gap-3 pt-3">
                  <p className="text-sm text-pretty text-muted-foreground">
                    Write or paste your conventions, both how things should look (palette, fonts,
                    layout) and how they should read (voice, grammar, warmth). Derive publishes them
                    as a doc your Brandprint points at, editable any time.
                  </p>
                  <Input
                    value={noteTitle}
                    placeholder="Title (optional, e.g. Voice & tone)"
                    aria-label="Doc title"
                    data-testid={`brandprint-notes-title-${scope}`}
                    onChange={(e) => setNoteTitle(e.target.value)}
                  />
                  <Textarea
                    value={notes}
                    rows={7}
                    placeholder="Our voice is plain and direct. Headings in sentence case. Dark slate on off-white, brand accent sparingly. Screenshots always carry a caption…"
                    aria-label="Your conventions"
                    data-testid={`brandprint-notes-${scope}`}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                  <Button
                    className="self-end"
                    data-testid={`brandprint-notes-create-${scope}`}
                    loading={importDocs.isPending}
                    disabled={importDocs.isPending || !notes.trim()}
                    onClick={createFromNotes}
                  >
                    {importDocs.isPending ? "Creating…" : "Create"}
                  </Button>
                </TabsContent>
                <TabsContent value="existing" className="flex flex-col gap-3 pt-3">
                  <p className="text-sm text-pretty text-muted-foreground">
                    Already keep your conventions in a collection? Point your Brandprint at it.
                  </p>
                  {(collections ?? []).length > 0 ? (
                    <SelectMenu
                      value=""
                      onValueChange={(v) => {
                        if (!v) return
                        save(v)
                        setCreateOpen(false)
                      }}
                    >
                      <SelectMenuTrigger
                        aria-label="Choose a collection"
                        data-testid={`brandprint-pick-collection-${scope}`}
                        className="self-start"
                      >
                        Choose a collection…
                      </SelectMenuTrigger>
                      <SelectMenuContent>
                        {(collections ?? []).map((c) => (
                          <SelectMenuItem key={c.id} value={c.id}>
                            {c.title}
                          </SelectMenuItem>
                        ))}
                      </SelectMenuContent>
                    </SelectMenu>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No collections here yet. Upload files or write your conventions instead.
                    </p>
                  )}
                </TabsContent>
              </Tabs>
            </DialogContent>
          </Dialog>
        </SettingRow>
      )}
      {scope === "account" &&
        (settings?.brandprint?.collectionId || settings?.brandprint?.profileId) && (
          <SettingRow
            htmlFor="brandprint-workspace-toggle"
            label="Use workspace Brandprint"
            description="Off: your agents skip this workspace's style and profile. Your personal conventions above still apply."
          >
            <Switch
              id="brandprint-workspace-toggle"
              data-testid="brandprint-workspace-toggle"
              checked={me?.brandprint?.useWorkspaceBrandprint !== false}
              disabled={
                toggleWorkspace.isPending || updateAccount.isPending || importDocs.isPending
              }
              onCheckedChange={(on) => toggleWorkspace.mutate(on)}
            />
          </SettingRow>
        )}
    </SettingsGroup>
  )
}

// The docs the Brandprint points at, managed here — the collection is hidden from
// the general collection surfaces (rail, palette, organize; see use-brandprint-ids),
// so this list is its one home. Removing drops the doc from the collection; the
// artifact itself lives on in the library. The brand-profile artifact rides in the
// collection too but has its own home (the panel above), so it's not listed here.
// The "Add a skill" picker: pick one of the workspace's skills into the Brandprint's
// collection. Skills are ordinary artifacts, so this is add-to-collection — the same
// endpoint the upload path uses — over the skill-filtered library listing.
function AddSkill({
  collectionId,
  scope,
  disabled,
}: {
  collectionId: string
  scope: "workspace" | "account"
  disabled: boolean
}) {
  const { data: skills, isError, refetch } = useQuery(workspaceSkillsQuery())
  const addSkill = useApiMutation({
    mutationFn: (shortId: string) => api.addToCollection(collectionId, shortId),
    invalidate: [brandprintDocsQuery(collectionId).queryKey, collectionsQuery().queryKey],
  })
  if (isError)
    return (
      <p className="text-sm text-muted-foreground">
        Couldn't load skills.{" "}
        <Button
          variant="link"
          size="xs"
          className="px-0"
          data-testid={`brandprint-skills-retry-${scope}`}
          onClick={() => refetch()}
        >
          Try again
        </Button>
      </p>
    )
  const available = skills ?? []
  return (
    <SelectMenu value="" onValueChange={(v) => v && addSkill.mutate(v)}>
      <SelectMenuTrigger
        aria-label="Add a skill"
        data-testid={`brandprint-add-skill-${scope}`}
        disabled={disabled || !skills || addSkill.isPending}
      >
        {!skills ? "Loading…" : addSkill.isPending ? "Adding…" : "Pick a skill"}
      </SelectMenuTrigger>
      <SelectMenuContent>
        {available.length === 0 ? (
          <SelectMenuItem value="" disabled>
            No skills yet — publish one with `derive init --template skill`
          </SelectMenuItem>
        ) : (
          available.map((s) => (
            <SelectMenuItem key={s.short_id} value={s.short_id}>
              {s.title ?? s.short_id}
            </SelectMenuItem>
          ))
        )}
      </SelectMenuContent>
    </SelectMenu>
  )
}

function BrandprintDocs({
  collectionId,
  scope,
  disabled,
  profileId,
}: {
  collectionId: string
  scope: "workspace" | "account"
  disabled: boolean
  profileId?: string
}) {
  const { data: allDocs, isError, refetch } = useQuery(brandprintDocsQuery(collectionId))
  const docs = allDocs?.filter((a) => a.short_id !== profileId)
  const removeDoc = useApiMutation({
    mutationFn: (shortId: string) => api.removeFromCollection(collectionId, shortId),
    pendingKey: (shortId) => shortId,
    invalidate: [brandprintDocsQuery(collectionId).queryKey, collectionsQuery().queryKey],
  })
  return (
    <div className="flex flex-col gap-2 py-3.5">
      <p className="text-sm font-medium text-foreground">Documents</p>
      {isError ? (
        <p className="text-sm text-muted-foreground">
          Couldn't load the docs.{" "}
          <Button
            variant="link"
            size="xs"
            className="px-0"
            data-testid={`brandprint-docs-retry-${scope}`}
            onClick={() => refetch()}
          >
            Try again
          </Button>
        </p>
      ) : !docs ? (
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-4 w-40" />
        </div>
      ) : docs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No docs yet. Upload some above.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {docs.map((a) => (
            <li key={a.short_id} className="flex items-center gap-2 text-sm">
              <Link
                to="/artifacts/$ref"
                params={{ ref: refFor(a) }}
                data-testid={`brandprint-doc-${a.short_id}`}
                className="min-w-0 flex-1 truncate text-foreground underline-offset-4 hover:underline"
              >
                {a.title ?? a.short_id}
              </Link>
              {a.current_content_type === "derive/skill" && (
                <Badge variant="secondary" shape="pill">
                  Skill
                </Badge>
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${a.title ?? a.short_id} from the Brandprint`}
                data-testid={`brandprint-doc-remove-${a.short_id}`}
                disabled={disabled || removeDoc.isPendingFor(a.short_id)}
                onClick={() => removeDoc.mutate(a.short_id)}
                className="text-muted-foreground"
              >
                <Icon name="close" size={14} />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

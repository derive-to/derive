import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useBlocker, useNavigate, useSearch } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { api, type TemplateLibraryEntry } from "@/api"
import { Icon } from "@/components/icons"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { PageShell } from "@/components/shared/page-shell"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { toast } from "@/components/ui/sonner"
import { artifactQuery, collectionsQuery, summaryQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { refFor } from "./artifact/parse-ref"
import { SourceEditor } from "./artifact/source-editor"
import { buildTemplateDraft } from "./templates/template-content"

// Guess Markdown vs HTML from the content, so paste just works (the editor drives
// highlighting + live preview off it). An opening structural tag or any closing
// tag reads as HTML; everything else is Markdown.
const detectFormat = (t: string): "md" | "html" => {
  const s = t.trim()
  if (!s) return "md"
  if (
    /^<(?:!doctype|html|body|head|div|section|article|main|header|footer|nav|h[1-6]|p|ul|ol|li|table|span|a|img|svg|style|script)\b/i.test(
      s,
    )
  )
    return "html"
  if (/<\/[a-z][\w-]*>/i.test(s)) return "html"
  return "md"
}

type StarterInput = TemplateLibraryEntry["inputs"][number]

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Input names are human-facing, so template authors may write `Project name`
// while their source uses `{{project_name}}`. Fill the obvious spellings only;
// anything more magical would make a starter harder to reason about.
const applyStarterBrief = (
  source: string,
  inputs: StarterInput[],
  values: Record<string, string>,
) =>
  inputs.reduce((next, input) => {
    const value = values[input.name]?.trim()
    if (!value) return next
    const spellings = [input.name, input.name.replace(/\s+/g, "_"), input.name.replace(/\s+/g, "-")]
    return spellings.reduce(
      (text, name) =>
        text.replace(new RegExp(`\\{\\{\\s*${escapeRegex(name)}\\s*\\}\\}`, "gi"), value),
      next,
    )
  }, source)

function StarterBriefDialog({
  entry,
  open,
  values,
  onOpenChange,
  onValueChange,
  onApply,
}: {
  entry: TemplateLibraryEntry
  open: boolean
  values: Record<string, string>
  onOpenChange: (open: boolean) => void
  onValueChange: (name: string, value: string) => void
  onApply: () => void
}) {
  const [error, setError] = useState("")
  const submit = () => {
    const missing = entry.inputs.filter((input) => input.required && !values[input.name]?.trim())
    if (missing.length) {
      setError(`Add ${missing.map((input) => input.name).join(" and ")} to start this draft.`)
      return
    }
    setError("")
    onApply()
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Set the starting brief</DialogTitle>
          <DialogDescription>
            Give {entry.title} the context it needs before the editor opens. This stays an ordinary
            editable draft.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          {entry.inputs.map((input) => (
            <label key={input.name} className="grid gap-1.5 text-sm font-medium text-foreground">
              {input.name}
              {input.required && <span className="text-destructive">Required</span>}
              <Input
                value={values[input.name] ?? ""}
                onChange={(event) => {
                  onValueChange(input.name, event.target.value)
                  if (error) setError("")
                }}
                placeholder={input.description}
                autoFocus={entry.inputs[0]?.name === input.name}
              />
              <span className="text-xs font-normal text-muted-foreground">{input.description}</span>
            </label>
          ))}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Skip for now
            </Button>
            <Button type="submit" data-testid="template-start-brief-continue">
              Start drafting <Icon name="arrow" />
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// Create a new artifact using the exact same editor as edit mode (SourceEditor):
// paste or write Markdown/HTML on the left, live preview on the right, editable
// title. Publishing creates the artifact (private by default; widen
// access from its Share menu) and opens it.
export function NewArtifact() {
  useDocumentTitle("New artifact")
  const nav = useNavigate()
  const search = useSearch({ from: "/new" })
  const templateDraft = buildTemplateDraft(search.template, search.theme)
  const [src, setSrc] = useState(() => templateDraft?.source ?? "")
  const [title, setTitle] = useState(() => templateDraft?.title ?? "")
  const [message, setMessage] = useState(() => templateDraft?.message ?? "")
  const [briefOpen, setBriefOpen] = useState(false)
  const [briefValues, setBriefValues] = useState<Record<string, string>>({})
  const [briefApplied, setBriefApplied] = useState(false)
  const sourceSeeded = useRef<string | null>(null)
  const sourceQuery = useQuery({
    queryKey: ["new-from-artifact", search.source] as const,
    enabled: !!search.source,
    retry: false,
    queryFn: async () => {
      const shortId = search.source as string
      const [artifact, content] = await Promise.all([
        api.getArtifact(shortId),
        api.getContent(shortId),
      ])
      return { artifact, content }
    },
  })
  const libraryStarterQuery = useQuery({
    queryKey: ["template-library-starter", search.library, search.entry] as const,
    enabled: !!search.library && !!search.entry,
    retry: false,
    queryFn: () => api.getTemplateStarter(search.library as string, search.entry as string),
  })

  // `?start=deck` (the library's "Start a deck") opens the editor on the canonical deck
  // starter instead of a blank page — the same file the CLI scaffolds and the MCP serves.
  // Imported lazily: it's ~12KB of HTML that only this one entry path ever needs, so it
  // stays out of the main bundle. It deliberately does NOT set the title — naming the deck
  // is the author's first act.
  //
  // The `cur || …` IS the idempotence guard, and it has to be the only one. An earlier
  // version also carried a `started` ref, which deadlocked with the cancel flag whenever
  // the effect was invoked twice (mount → cleanup → mount): the ref refused the second
  // import while the cleanup had already cancelled the first, so the editor stayed empty
  // forever. A production build never double-invokes, so it worked in the deploy preview
  // and only failed locally — the e2e caught it.
  useEffect(() => {
    if (search.start !== "deck") return
    let cancelled = false
    import("@/lib/deck-template.gen").then(({ DECK_TEMPLATE }) => {
      // Functional update: never clobber anything already typed or pasted.
      if (!cancelled) setSrc((cur) => cur || DECK_TEMPLATE)
    })
    return () => {
      cancelled = true
    }
  }, [search.start])

  useEffect(() => {
    if (!search.source || !sourceQuery.data || sourceSeeded.current === search.source) return
    sourceSeeded.current = search.source
    const { artifact, content } = sourceQuery.data
    setSrc(content)
    setTitle(artifact.title ? `${artifact.title} — derived` : "Derived artifact")
    setMessage(`Created from ${artifact.title ?? artifact.short_id} v${artifact.current_version}`)
  }, [search.source, sourceQuery.data])

  useEffect(() => {
    const starter = libraryStarterQuery.data
    const key = search.library && search.entry ? `${search.library}/${search.entry}` : null
    if (!key || !starter || sourceSeeded.current === key) return
    sourceSeeded.current = key
    setSrc(starter.source)
    setTitle(starter.entry.title)
    setMessage(
      `Created from template library entry ${starter.entry.title} · source v${starter.entry.source_version}`,
    )
    if (starter.entry.inputs.length) {
      setBriefValues(Object.fromEntries(starter.entry.inputs.map((input) => [input.name, ""])))
      setBriefApplied(false)
      setBriefOpen(true)
    }
  }, [search.entry, search.library, libraryStarterQuery.data])

  const applyBrief = () => {
    const starter = libraryStarterQuery.data
    if (!starter) return
    const brief = starter.entry.inputs
      .map((input) => [input.name, briefValues[input.name]?.trim()] as const)
      .filter(([, value]) => !!value)
      .map(([name, value]) => `${name}: ${value}`)
    setSrc((current) => applyStarterBrief(current, starter.entry.inputs, briefValues))
    setTitle((current) => applyStarterBrief(current, starter.entry.inputs, briefValues))
    setMessage(
      `Created from template library entry ${starter.entry.title} · source v${starter.entry.source_version}${brief.length ? ` · brief: ${brief.join("; ")}` : ""}`,
    )
    setBriefApplied(true)
    setBriefOpen(false)
  }

  const format =
    templateDraft?.format ??
    libraryStarterQuery.data?.entry.format ??
    (sourceQuery.data?.artifact.current_content_type === "text/markdown" ? "md" : detectFormat(src))

  // A draft is dirty once anything's been typed. Publishing must bypass the guard for its
  // own nav to the artifact — via a REF, not state: publish() sets it and calls nav() in the
  // same tick, so a batched state update wouldn't be reflected in the blocker's closure yet
  // (the nav would fire the discard dialog on the very success path it's meant to allow).
  // A ref updates synchronously, so shouldBlockFn sees the bypass immediately.
  const publishing = useRef(false)
  const qc = useQueryClient()
  const dirty = !!(src.trim() || title.trim() || message.trim())

  // Guard leaving with an unsaved draft — BOTH in-app navigation (rail click, Cancel) and
  // a browser close/refresh (enableBeforeUnload). withResolver gives us proceed/reset to
  // drive the shared ConfirmDialog instead of the browser's native prompt for in-app navs.
  const blocker = useBlocker({
    shouldBlockFn: () => dirty && !publishing.current,
    enableBeforeUnload: () => dirty && !publishing.current,
    withResolver: true,
  })

  const publishMut = useApiMutation({
    mutationFn: () => {
      const name = title.trim() || "Untitled"
      const ext = format === "md" ? "md" : "html"
      const type = format === "md" ? "text/markdown" : "text/html"
      const fields: Record<string, string> = { title: name }
      if (message.trim()) fields.message = message.trim()
      return api.publish(new File([src], `inline.${ext}`, { type }), fields)
    },
    // Freshen the library so the new artifact + bumped total are correct on return.
    invalidate: [summaryQuery().queryKey, collectionsQuery().queryKey, ["artifacts"]],
    onSuccess: (a) => {
      // The response IS the record the artifact page is about to fetch — seed it, so
      // the workbench header paints on arrival instead of after a second round trip,
      // and start the raw-content fetch now so the iframe finds a warm HTTP cache.
      // Publish is the moment a person is most likely to be watching the screen.
      // The publish response is deliberately lean and has no viewer-specific role.
      // We do know one fact locally: the person who just created this artifact owns it.
      // Preserve that while the detail query warms, otherwise the first artifact paint
      // briefly hides every editor-only affordance (including Inspect) until a reload.
      qc.setQueryData(artifactQuery(a.short_id).queryKey, { ...a, my_role: "owner" })
      // Drop the unsaved guard before navigating to the artifact (this nav IS the save,
      // not an abandon), so the blocker doesn't intercept it. Ref, so it's in effect the
      // instant nav() runs — see the note on `publishing` above.
      publishing.current = true
      if (search.next === "context") {
        nav({
          to: "/contexts",
          search: {
            manifest: a.short_id,
            name: search.contextName ?? templateDraft?.template.title,
            origin: search.contextName ?? templateDraft?.template.title,
          },
        })
      } else {
        nav({ to: "/artifacts/$ref", params: { ref: refFor(a) } })
      }
    },
  })
  const publish = () => {
    if (!src.trim()) {
      toast.error("Add some content first.")
      return
    }
    publishMut.mutate()
  }

  if (
    (search.source && sourceQuery.isPending) ||
    (search.library && search.entry && libraryStarterQuery.isPending)
  ) {
    return (
      <PageShell className="flex flex-col gap-4">
        <StatusPanel
          tone="neutral"
          title="Preparing a new draft"
          description="Reading the current source and preserving its origin."
        />
      </PageShell>
    )
  }

  if (
    (search.source && sourceQuery.isError) ||
    (search.library && search.entry && libraryStarterQuery.isError)
  ) {
    return (
      <PageShell className="flex flex-col gap-4">
        <StatusPanel
          tone="danger"
          title="Couldn't read that starting point"
          description="Check that the artifact or template library is still available and that you have access."
          action={
            <Button
              variant="outline"
              data-testid="new-source-back"
              onClick={() => nav({ to: "/templates", search: { derive: true } })}
            >
              Back to templates
            </Button>
          }
        />
      </PageShell>
    )
  }

  const origin = templateDraft
    ? {
        label: templateDraft.template.title,
        meta: templateDraft.theme
          ? `${templateDraft.origin.libraryId} · v${templateDraft.origin.catalogVersion} · ${templateDraft.theme.title}`
          : `${templateDraft.origin.libraryId} · v${templateDraft.origin.catalogVersion}`,
      }
    : sourceQuery.data
      ? {
          label: sourceQuery.data.artifact.title ?? sourceQuery.data.artifact.short_id,
          meta: `Artifact · v${sourceQuery.data.artifact.current_version}`,
        }
      : libraryStarterQuery.data
        ? {
            label: libraryStarterQuery.data.entry.title,
            meta: `Template library · source v${libraryStarterQuery.data.entry.source_version}`,
          }
        : null
  const starterInputs = libraryStarterQuery.data?.entry.inputs ?? []
  const briefItems = starterInputs
    .map((input) => [input.name, briefValues[input.name]?.trim()] as const)
    .filter(([, value]) => !!value)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {origin && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-secondary px-3 py-2 sm:px-4">
          <Icon name="derive" className="text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Starting from {origin.label}</span>
          <span className="font-mono text-2xs text-muted-foreground">{origin.meta}</span>
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto"
            data-testid="new-change-template"
            onClick={() => nav({ to: "/templates" })}
          >
            Change start
          </Button>
        </div>
      )}
      {briefApplied && briefItems.length > 0 && (
        <section
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background px-3 py-2 text-sm sm:px-4"
          data-testid="template-start-brief"
        >
          <span className="font-medium text-foreground">Starting brief</span>
          {briefItems.map(([name, value]) => (
            <span key={name} className="text-muted-foreground">
              {name}: <span className="text-foreground">{value}</span>
            </span>
          ))}
        </section>
      )}
      <SourceEditor
        canPublish
        title={title}
        onTitle={setTitle}
        format={format}
        src={src}
        message={message}
        proposeMsg=""
        onSrc={setSrc}
        onMessage={setMessage}
        onProposeMsg={() => {}}
        onCancel={() => nav({ to: "/" })}
        onPublish={publish}
        onPropose={() => {}}
        publishing={publishMut.isPending}
        placeholder={
          templateDraft || libraryStarterQuery.data
            ? "Replace the template prompts with your content — the preview updates as you work."
            : "Write or paste Markdown or HTML — the preview updates as you type."
        }
      />
      {/* The unsaved-draft confirm: fires for any blocked departure (Cancel, a rail click,
          back). Discarding proceeds; keeping resets you to the editor with the draft intact. */}
      <ConfirmDialog
        open={blocker.status === "blocked"}
        onOpenChange={(o) => {
          if (!o && blocker.status === "blocked") blocker.reset()
        }}
        title="Discard this draft?"
        description="You have unpublished changes. Leaving now discards them — this can't be undone."
        confirmLabel="Discard"
        confirmTestId="new-discard-confirm"
        onConfirm={() => {
          if (blocker.status === "blocked") blocker.proceed()
        }}
      />
      {libraryStarterQuery.data && starterInputs.length > 0 && (
        <StarterBriefDialog
          entry={libraryStarterQuery.data.entry}
          open={briefOpen}
          values={briefValues}
          onOpenChange={setBriefOpen}
          onValueChange={(name, value) =>
            setBriefValues((current) => ({ ...current, [name]: value }))
          }
          onApply={applyBrief}
        />
      )}
    </div>
  )
}

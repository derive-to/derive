import { useQuery } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { useRef, useState } from "react"
import { type Agent, type Artifact, api } from "@/api"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  accountsQuery,
  agentConnectionsQuery,
  agentsQuery,
  artifactQuery,
  pageAsksQuery,
} from "@/lib/queries"
import { skillBundleBytes } from "@/lib/skill-source"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { AskPanel } from "@/pages/artifact/ask-panel"
import { accountLabel } from "../settings/accounts-section"
import { modelChoices } from "./format"

const EXAMPLES = [
  {
    name: "Daily cloud health",
    brief:
      "Check our public health endpoints live. Show the status and response time. Save a short report with the check time and source URLs.",
    daily: true,
  },
  {
    name: "Keep docs current",
    brief:
      "Compare the docs with recent code changes. Fix stale examples and open a pull request with a short explanation.",
    daily: false,
  },
  {
    name: "Check a release",
    brief:
      "Open the app and check its main flows. Save screenshots and report any failure with clear steps to repeat it.",
    daily: false,
  },
]
const skillFor = (name: string, brief: string) =>
  `---\nname: ${
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .replace(/-+$/, "") || "agent"
  }\ndescription: ${JSON.stringify((brief.trim().split("\n")[0] ?? "").slice(0, 1024))}\n---\n\n# ${name.trim()}\n\n${brief.trim()}\n\nUse live sources. Save evidence and state what you could not verify.\nUse only the connections and secrets assigned to this agent.\nAsk before you send a message or make an irreversible change.\n`

/** The skill is a versioned page. AI authoring uses the existing Chat panel. */
export function NewAgent() {
  useDocumentTitle("New agent")
  const navigate = useNavigate()
  const runtime = useQuery({ queryKey: ["agents", "runtime"], queryFn: api.agentRuntime })
  const accounts = useQuery(accountsQuery())
  const connections = useQuery(agentConnectionsQuery())
  const agents = useQuery(agentsQuery())
  const [name, setName] = useState("")
  const search = getRouteApi("/agents/new").useSearch()
  const [brief, setBrief] = useState(search.brief ?? "")
  const [daily, setDaily] = useState(false)
  const [time, setTime] = useState("09:00")
  const [account, setAccount] = useState("")
  const [model, setModel] = useState("")
  const [sources, setSources] = useState<string[]>([])
  const [chat, setChat] = useState(false)
  const [start, setStart] = useState(true)
  const skill = useRef<Artifact | null>(null)
  const created = useRef<Agent | null>(null)
  const [savedSkill, setSavedSkill] = useState<string | null>(null)
  const latestSkill = useQuery({ ...artifactQuery(savedSkill ?? ""), enabled: !!savedSkill })
  const skillChats = useQuery({ ...pageAsksQuery(savedSkill ?? ""), enabled: !!savedSkill })
  const writing =
    skillChats.data?.some((job) => ["queued", "running", "needs_you"].includes(job.status)) ?? false
  const firstTaskKey = useRef(crypto.randomUUID())
  const readyAccounts = accounts.data ?? []
  const chosen = readyAccounts.find((a) => a.id === (account || readyAccounts[0]?.id))
  const duplicate =
    !created.current && agents.data?.some((a) => a.name.toLowerCase() === name.trim().toLowerCase())
  const ready =
    runtime.data?.enabled && !!chosen && name.trim() && brief.trim() && !duplicate && !writing

  const saveSkill = async () => {
    if (!skill.current) {
      const bundle = await skillBundleBytes(skillFor(name, brief))
      skill.current = await api.publish(
        new File([new Uint8Array(bundle)], "skill.zip", { type: "application/zip" }),
        {
          title: `${name.trim()} skill`,
          workspace_access: "member",
          link_role: "none",
          listed: "none",
        },
      )
      setSavedSkill(skill.current.short_id)
    }
    return skill.current
  }
  const draft = useApiMutation({
    mutationFn: async () => {
      const page = await saveSkill()
      await api.askAgent(
        "derive",
        `Help me write this skill. Keep it short and clear. The agent should do this: ${brief.trim()}. Update the skill on this page. The task runner saves the final answer as a report artifact. Put simple results in the final answer. Create extra artifacts only when requested. Use sensible defaults. Ask only when missing details block the work.`,
        { kind: "artifact", id: page.short_id },
      )
      setChat(true)
    },
    invalidate: [["jobs"]],
  })
  const create = useApiMutation({
    mutationFn: async () => {
      if (!chosen) throw new Error("Connect a model account first")
      const [hour, minute] = time.split(":").map(Number)
      const schedule = daily
        ? {
            cron: `${minute} ${hour} * * *`,
            tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
            instruction: brief.trim(),
          }
        : null
      if (!created.current) {
        const page = await saveSkill()
        const input = {
          name: name.trim(),
          description: brief.trim().slice(0, 280),
          instructions_short_id: page.short_id,
          machine: "derive",
          provider: chosen.provider === "codex" ? "codex" : "claude-code",
          account_id: chosen.id,
          model: model.trim() || null,
          connection_ids: sources,
          max_run_ms: 600_000,
          max_concurrency: 1,
          ...(schedule ? { schedule } : {}),
        } satisfies Parameters<typeof api.createAgent>[0]
        try {
          created.current = await api.createAgent(input)
        } catch (error) {
          // Recover a lost response only for this form's unique skill page.
          const found = (await api.listAgents()).agents.find(
            (a) => a.name === input.name && a.instructions_short_id === page.short_id,
          )
          if (!found) throw error
          created.current = found
        }
      }
      // Creation can persist before its schedule response fails. Read before repair,
      // including on retry, so a lost trigger response cannot add another schedule.
      if (schedule) {
        const detail = await api.getAgent(created.current.id)
        if (
          !detail.triggers.some(
            (t) =>
              t.cron === schedule.cron &&
              t.tz === schedule.tz &&
              t.instruction === schedule.instruction,
          )
        )
          await api.addTrigger(created.current.id, schedule)
      }
      if (start) {
        await api.askAgent(created.current.id, brief.trim(), undefined, {
          dedupe_key: firstTaskKey.current,
        })
      }
      return created.current
    },
    invalidate: [["agents"], ["jobs"]],
    onSuccess: (agent) =>
      void navigate({ to: "/agents/$id", params: { id: agent.id }, search: {} }),
  })

  return (
    <PageShell width="wide" className="flex flex-col gap-7">
      <PageHeader title="Let’s make an agent" />
      <div className={chat ? "grid gap-10 lg:grid-cols-[minmax(0,1fr)_24rem]" : "max-w-2xl"}>
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault()
            if (ready && !create.isPending) create.mutate()
          }}
        >
          <p className="text-base text-muted-foreground">
            Give it a skill. Let it take care of the repeat work.
          </p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <Button
                key={example.name}
                type="button"
                variant="outline"
                size="sm"
                data-testid={`new-agent-example-${example.name.toLowerCase().replaceAll(" ", "-")}`}
                disabled={!!savedSkill || create.isPending}
                onClick={() => {
                  setName(example.name)
                  setBrief(example.brief)
                  setDaily(example.daily)
                }}
              >
                {example.name}
              </Button>
            ))}
          </div>
          <label className="flex flex-col gap-2 text-sm">
            Name
            <Input
              data-testid="new-agent-name"
              value={name}
              maxLength={160}
              required
              disabled={!!savedSkill || create.isPending}
              onChange={(e) => setName(e.target.value)}
              placeholder="Daily cloud health"
            />
          </label>
          <label className="flex flex-col gap-2 text-sm">
            What should it do?
            <Textarea
              data-testid="new-agent-brief"
              value={brief}
              required
              maxLength={20_000}
              disabled={!!savedSkill || create.isPending}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="Tell it what a good result looks like…"
              className="min-h-32 text-base"
            />
          </label>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="new-agent-draft"
              disabled={!name.trim() || !brief.trim() || create.isPending}
              loading={draft.isPending}
              onClick={() => (savedSkill ? setChat(true) : draft.mutate())}
            >
              {savedSkill ? "Keep writing with AI" : "Write the skill with AI"}
            </Button>
            {savedSkill ? (
              <Link
                to="/artifacts/$ref"
                params={{ ref: savedSkill }}
                data-testid="new-agent-skill-link"
                className="text-foreground underline-offset-4 hover:underline"
              >
                Open skill
              </Link>
            ) : (
              <span className="text-muted-foreground">You can edit its skill anytime.</span>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm">
              Model account
              <select
                data-testid="new-agent-account"
                value={chosen?.id ?? ""}
                onChange={(e) => {
                  setAccount(e.target.value)
                  setModel("")
                }}
                disabled={create.isPending}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {!readyAccounts.length && <option value="">Connect an account</option>}
                {readyAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountLabel(a)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-2 text-sm">
              Run
              <select
                data-testid="new-agent-cadence"
                value={daily ? "daily" : "asked"}
                disabled={create.isPending}
                onChange={(e) => setDaily(e.target.value === "daily")}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="asked">When I ask</option>
                <option value="daily">Every day</option>
              </select>
            </label>
          </div>
          {daily && (
            <label className="flex flex-col gap-2 text-sm">
              Time · {Intl.DateTimeFormat().resolvedOptions().timeZone}
              <Input
                data-testid="new-agent-time"
                type="time"
                value={time}
                required
                onChange={(e) => setTime(e.target.value)}
                className="max-w-40"
              />
            </label>
          )}
          <details className="text-sm" data-testid="new-agent-options">
            <summary className="cursor-pointer text-muted-foreground">Model and access</summary>
            <div className="mt-4 flex flex-col gap-4">
              <label className="flex flex-col gap-2">
                Model
                <select
                  data-testid="new-agent-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Use the account’s default</option>
                  {modelChoices(chosen?.provider === "codex" ? "codex" : "claude-code").map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-muted-foreground">
                Connections give it access. The skill tells it how to use that access.
              </p>
              {(connections.data ?? [])
                .filter((c) => c.status === "active" && c.toolkit !== "secret")
                .map((c) => (
                  <label key={c.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      data-testid={`new-agent-source-${c.id}`}
                      checked={sources.includes(c.id)}
                      onChange={(e) =>
                        setSources(
                          e.target.checked
                            ? [...sources, c.id]
                            : sources.filter((id) => id !== c.id),
                        )
                      }
                    />
                    {c.toolkit}
                  </label>
                ))}
              <Link
                to="/settings/$section"
                params={{ section: "sources" }}
                data-testid="new-agent-connect-source"
                className="underline-offset-4 hover:underline"
              >
                Connect a source
              </Link>
            </div>
          </details>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="new-agent-start-now"
              checked={start}
              onChange={(e) => setStart(e.target.checked)}
            />
            Run the first task now
          </label>
          {(runtime.isError || accounts.isError || connections.isError) && (
            <p role="alert" className="text-sm text-destructive">
              Couldn’t load setup. Refresh to try again.
            </p>
          )}
          {runtime.data && !runtime.data.enabled && (
            <p className="text-sm text-warning">
              Cloud runs need a sandbox connection on this server.
            </p>
          )}
          {!accounts.isPending && !readyAccounts.length && (
            <p className="text-sm text-muted-foreground">
              Connect your plan or provider to get going.{" "}
              <Link
                to="/settings/$section"
                params={{ section: "accounts" }}
                data-testid="new-agent-connect-account"
                className="underline"
              >
                Connect an account
              </Link>
            </p>
          )}
          {duplicate && (
            <p role="alert" className="text-sm text-warning">
              An agent has this name. Give this one a new name.
            </p>
          )}
          {writing && (
            <p role="status" className="text-sm text-muted-foreground">
              Finish writing the skill in Chat, then let’s go.
            </p>
          )}
          <div className="flex items-center gap-4">
            <Button
              type="submit"
              data-testid="new-agent-go"
              disabled={!ready || draft.isPending}
              loading={create.isPending}
            >
              {start ? "Let’s go" : "Create agent"}
            </Button>
            {runtime.data?.enabled && (
              <span className="text-sm text-muted-foreground">
                Runs in the cloud · {runtime.data.provider === "box" ? "Box" : "Ortam"}
              </span>
            )}
          </div>
        </form>
        {chat && savedSkill && (
          <aside className="min-h-96 rounded-xl border border-border" aria-label="Write your skill">
            <AskPanel
              shortId={savedSkill}
              currentVersion={latestSkill.data?.current_version ?? 1}
              onGoToVersion={() =>
                void navigate({ to: "/artifacts/$ref", params: { ref: savedSkill } })
              }
              onClose={() => setChat(false)}
            />
          </aside>
        )}
      </div>
    </PageShell>
  )
}

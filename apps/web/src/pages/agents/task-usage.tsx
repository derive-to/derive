import { useState } from "react"
import type { Agent, Job } from "@/api"
import { SectionHeading } from "@/components/shared/section-title"
import { useMemberNames } from "./use-member-names"

type Run = NonNullable<Job["result"]["runs"]>[number]
const dollars = (micro: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(micro / 1_000_000)
const number = (n: number) =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n)

// Each receipt keeps its price version. Old receipts without one stay unknown.
const estimate = (run: Run): number | null =>
  run.api_estimate_micro_usd ?? run.harness_estimate_micro_usd ?? null
const sumKnown = (values: (number | null)[]) =>
  values.length && values.every((n) => n !== null)
    ? values.reduce<number>((sum, n) => sum + (n ?? 0), 0)
    : null
const taskEstimate = (job: Job) => {
  if (!["succeeded", "failed", "cancelled", "lost"].includes(job.status)) return null
  const runs = job.result.runs ?? []
  // Older records cannot distinguish a fresh run from a manually reset retry cycle.
  if (job.result.claim_ledger_version !== 1 || job.result.attempt_offset === undefined) return null
  // An unreported claim still consumed work. Never present a partial retry history
  // as the cost of the whole task.
  for (let attempt = 0; attempt <= job.result.attempt_offset; attempt++)
    if (!runs.some((run) => run.attempt === attempt)) return null
  return sumKnown(runs.map(estimate))
}
const cacheShare = (runs: Run[]) => {
  const measured = runs.filter((r) => r.input_tokens !== null && r.cached_input_tokens !== null)
  const input = sumKnown(measured.map((r) => r.input_tokens))
  const cached = sumKnown(measured.map((r) => r.cached_input_tokens))
  return input && cached !== null ? `${Math.round((cached / input) * 100)}%` : "Unknown"
}
const average = (values: (number | null)[]) => {
  const known = values.filter((n): n is number => n !== null)
  const total = sumKnown(known)
  return total === null ? null : total / known.length
}

/** Summaries cover the loaded tasks. Plan usage, reported spend, and API estimates
 * have separate labels. Failed attempts remain in every spend and token total. */
export function TaskUsage({ jobs, agents }: { jobs: Job[]; agents?: Agent[] }) {
  const [groupBy, setGroupBy] = useState<"agent" | "person">("agent")
  const names = useMemberNames()
  const personOf = (job: Job) => job.asked_by ?? (job.kind === "scheduled" ? "schedule" : "unknown")
  const settled = jobs.filter((j) =>
    ["succeeded", "failed", "cancelled", "lost"].includes(j.status),
  )
  const runs = jobs.flatMap((j) => j.result.runs ?? [])
  const compute = jobs.flatMap((j) => j.result.compute ?? [])
  if (!runs.length && !compute.length)
    return (
      <section data-testid="task-usage-empty" className="flex flex-col gap-2 py-5">
        <SectionHeading>Costs start with your first run.</SectionHeading>
        <p className="text-base text-muted-foreground">
          Each task keeps its model, token usage, and available costs here.
        </p>
        <p className="text-sm text-muted-foreground">
          Missing receipts stay unknown. A plan account does not report a dollar bill.
        </p>
      </section>
    )
  const completed = settled.filter((j) => j.status === "succeeded")
  const known = jobs.filter((j) => j.cost_micro_usd !== null)
  const spend = known.reduce((n, j) => n + (j.cost_micro_usd ?? 0), 0)
  const estimatedTasks = settled.flatMap((j) => {
    const cost = taskEstimate(j)
    return cost === null ? [] : [{ job: j, cost }]
  })
  const estimatedCompleted = estimatedTasks.filter(({ job }) => job.status === "succeeded")
  const estimatedPerTask =
    completed.length && estimatedTasks.length === settled.length
      ? estimatedTasks.reduce((n, { cost }) => n + cost, 0) / completed.length
      : null
  const groups = new Map<string, Run[]>()
  for (const run of runs) {
    const key = `${run.provider} · ${run.model}`
    groups.set(key, [...(groups.get(key) ?? []), run])
  }
  const knownCompute = compute.filter((c) => c.cost_micro_usd !== null)
  const measured = runs.filter((r) => r.input_tokens !== null && r.output_tokens !== null)
  return (
    <section aria-label="AI usage" data-testid="task-usage" className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
        {[
          ["Completed tasks", `${completed.length}/${settled.length}`],
          ["Reported AI subtotal", known.length ? dollars(spend) : "Unknown"],
          [
            "Cost estimate / success",
            estimatedPerTask === null ? "Unknown" : dollars(estimatedPerTask),
          ],
          ["Cache reused", cacheShare(runs)],
        ].map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1">
            <span className="text-sm text-muted-foreground">{label}</span>
            <span className="font-mono text-xl tabular-nums">{value}</span>
          </div>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        Recent tasks · Cost per success includes failed tasks and retries. API estimates do not
        price your plan.
        {jobs.length > settled.length && " Active tasks show the receipts received so far."}
        {known.length < jobs.length &&
          " Plan charges can stay unknown. A missing charge does not mean free."}
      </p>
      <details className="text-sm text-muted-foreground" data-testid="task-usage-coverage">
        <summary>Receipt coverage</summary>
        <p className="mt-2">
          {jobs.length} loaded tasks · {measured.length}/{runs.length} model runs have token
          receipts · {known.length}/{jobs.length} tasks report at least one dollar cost.
          {known.length < jobs.length && " Plans do not report dollar spend."}
          {" Missing attempt costs stay unknown."}
          {estimatedCompleted.length > 0 &&
            ` API estimates cover ${estimatedTasks.length}/${settled.length} tasks. Missing task costs keep cost per success unknown.`}
        </p>
      </details>
      {agents && (
        <div className="overflow-x-auto">
          <div className="mb-3 flex items-center justify-between gap-3">
            <SectionHeading>By {groupBy}</SectionHeading>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Group by
              <select
                data-testid="task-usage-group"
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value === "person" ? "person" : "agent")}
                className="rounded-md border border-border bg-background px-2 py-1 text-foreground"
              >
                <option value="agent">Agent</option>
                <option value="person">Person</option>
              </select>
            </label>
          </div>
          <table className="w-full text-left text-sm" data-testid={`task-usage-by-${groupBy}`}>
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 font-normal">
                  {groupBy === "agent" ? "Agent" : "Started by"}
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  Completed
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  Reported AI
                </th>
                <th scope="col" className="py-2 text-right font-normal">
                  Cost estimate / success
                </th>
              </tr>
            </thead>
            <tbody>
              {[
                ...new Set(
                  groupBy === "agent"
                    ? [...agents.map((a) => a.id), ...jobs.map((j) => j.agent_id)]
                    : jobs.map(personOf),
                ),
              ].map((id) => {
                const name =
                  groupBy === "agent"
                    ? (agents.find((a) => a.id === id)?.name ??
                      (id === "derive" ? "Chat" : "Removed agent"))
                    : names.get(id) ||
                      (id === "schedule"
                        ? "Schedule"
                        : id === "unknown"
                          ? "Unknown person"
                          : "Former member")
                const tasks = jobs.filter(
                  (j) => (groupBy === "agent" ? j.agent_id : personOf(j)) === id,
                )
                const done = tasks.filter((j) => j.status === "succeeded")
                const reported = tasks.filter((j) => j.cost_micro_usd !== null)
                const estimates = tasks.map(taskEstimate).filter((n): n is number => n !== null)
                const apiCost =
                  done.length && estimates.length === tasks.length
                    ? estimates.reduce((n, cost) => n + cost, 0) / done.length
                    : null
                return (
                  <tr key={id} className="border-t border-border">
                    <th scope="row" className="py-3 font-medium">
                      {name}
                    </th>
                    <td className="px-3 font-mono">
                      {done.length}/{tasks.length}
                    </td>
                    <td className="px-3 font-mono">
                      {reported.length
                        ? dollars(reported.reduce((n, j) => n + (j.cost_micro_usd ?? 0), 0))
                        : "Unknown"}
                    </td>
                    <td className="text-right font-mono">
                      {apiCost === null ? (
                        "Unknown"
                      ) : (
                        <>
                          {dollars(apiCost)}
                          <span className="block font-sans text-sm text-muted-foreground">
                            {estimates.length}/{tasks.length} tasks
                          </span>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {groups.size > 0 && (
        <details open={groups.size > 1} data-testid="task-usage-compare">
          <summary className="cursor-pointer text-sm">Compare models</summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 font-normal">
                    Model
                  </th>
                  <th scope="col" className="px-3 py-2 font-normal">
                    Input / run
                  </th>
                  <th scope="col" className="px-3 py-2 font-normal">
                    Cache
                  </th>
                  <th scope="col" className="px-3 py-2 font-normal">
                    Time / run
                  </th>
                  <th scope="col" className="px-3 py-2 font-normal">
                    Reported / run
                  </th>
                  <th scope="col" className="py-2 text-right font-normal">
                    Cost estimate / run
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...groups].map(([key, group]) => {
                  const input = average(group.map((r) => r.input_tokens))
                  const priced = group.filter((r) => r.model_cost_micro_usd !== null)
                  const estimated = average(group.map(estimate))
                  return (
                    <tr key={key} className="border-t border-border">
                      <th scope="row" className="py-3 font-normal">
                        {key}
                        <span className="block text-xs text-muted-foreground">
                          {group.length} runs ·{" "}
                          {
                            group.filter((r) => r.input_tokens !== null && r.output_tokens !== null)
                              .length
                          }{" "}
                          measured
                        </span>
                      </th>
                      <td className="px-3 font-mono tabular-nums">
                        {input === null ? "Unknown" : number(input)}
                      </td>
                      <td className="px-3 font-mono tabular-nums">{cacheShare(group)}</td>
                      <td className="px-3 font-mono tabular-nums">
                        {Math.round(
                          group.reduce((n, r) => n + r.duration_ms, 0) / group.length / 1000,
                        )}
                        s
                      </td>
                      <td className="px-3 font-mono tabular-nums">
                        {priced.length
                          ? `${dollars(priced.reduce((n, r) => n + (r.model_cost_micro_usd ?? 0), 0) / priced.length)} (${priced.length}/${group.length})`
                          : "Unknown"}
                      </td>
                      <td className="text-right font-mono tabular-nums">
                        {estimated === null ? "Unknown" : dollars(estimated)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Token and cost averages use available receipts. Time includes all runs. Compare the
            reports too.
          </p>
        </details>
      )}
      {estimatedTasks.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">How we estimate API cost</summary>
          <p className="mt-2">
            Standard text rates, checked October 12, 2026. This compares measured tokens with API
            prices. It does not price your plan. Tool fees, cache writes, regional fees and other
            service tiers are excluded. Large contexts and unsupported models stay unknown.
          </p>
          <p className="mt-2">
            <a
              className="underline"
              href="https://developers.openai.com/api/docs/models/gpt-6-luna"
              target="_blank"
              rel="noreferrer"
            >
              Luna rates
            </a>
            {" · "}
            <a
              className="underline"
              href="https://developers.openai.com/api/docs/models/gpt-6.1-sol"
              target="_blank"
              rel="noreferrer"
            >
              Sol rates
            </a>
          </p>
        </details>
      )}
      {compute.length > 0 && (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">
            Sandbox spend ·{" "}
            {knownCompute.length
              ? dollars(knownCompute.reduce((n, c) => n + (c.cost_micro_usd ?? 0), 0))
              : "Unknown"}
          </summary>
          <p className="mt-2">
            {knownCompute.length}/{compute.length} runs have a settled provider receipt. Setup
            before the first task is separate.
          </p>
        </details>
      )}
    </section>
  )
}

export function TaskReceipt({ job }: { job: Job }) {
  const runs = job.result.runs ?? []
  const estimated = taskEstimate(job)
  return (
    <div
      data-testid={`task-receipt-${job.id}`}
      className="flex flex-col gap-2 border-t border-border py-3 text-sm"
    >
      <p className="text-muted-foreground">
        Reported AI subtotal:{" "}
        <span className="font-mono text-foreground">
          {job.cost_micro_usd === null ? "Unknown" : dollars(job.cost_micro_usd)}
        </span>
        {estimated !== null && (
          <>
            {" "}
            · Cost estimate: <span className="font-mono text-foreground">{dollars(estimated)}</span>
          </>
        )}
      </p>
      {runs.map((r, i) => (
        <p key={`${r.attempt}-${i}`} className="text-muted-foreground">
          Attempt {r.attempt + 1} · {r.model} · {Math.round(r.duration_ms / 1000)}s ·{" "}
          {r.input_tokens === null ? "Unknown input" : `${number(r.input_tokens)} input`} ·{" "}
          {r.output_tokens === null ? "Unknown output" : `${number(r.output_tokens)} output`}
          {r.cached_input_tokens !== null && ` · ${number(r.cached_input_tokens)} cached`}
          {r.harness_estimate_micro_usd != null &&
            ` · CLI estimate ${dollars(r.harness_estimate_micro_usd)}`}
          {r.api_estimate_micro_usd != null &&
            ` · API comparison ${dollars(r.api_estimate_micro_usd)}`}
          {r.skill && ` · Skill v${r.skill.version}`}
        </p>
      ))}
      {!runs.length && (
        <p className="text-muted-foreground">This runner has not reported token usage.</p>
      )}
      {(job.result.compute ?? []).map((c) => (
        <p key={c.turn} className="text-muted-foreground">
          {c.provider === "boat" ? "boat.dev" : "Ortam"} · compute stopped ·{" "}
          {c.billable_seconds === null
            ? "Unknown billable time"
            : `${number(c.billable_seconds)} billable seconds`}{" "}
          · {c.cost_micro_usd === null ? "Unknown cost" : dollars(c.cost_micro_usd)}
        </p>
      ))}
    </div>
  )
}

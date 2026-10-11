import type { Job } from "@/api"

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

// Standard text rates per million tokens, checked 2026-10-11. This is a comparison
// estimate, never a charge or budget input. Unknown models and long contexts stay unknown.
const API_RATES: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5 },
  "gpt-6.1-sol": { input: 2, cached: 0.1, output: 10 },
}
const estimate = (run: Run): number | null => {
  const rate = run.provider === "codex" ? API_RATES[run.model] : undefined
  if (
    !rate ||
    run.input_tokens === null ||
    run.cached_input_tokens === null ||
    run.output_tokens === null ||
    run.input_tokens > 272_000 ||
    run.cached_input_tokens > run.input_tokens
  )
    return null
  return (
    (run.input_tokens - run.cached_input_tokens) * rate.input +
    run.cached_input_tokens * rate.cached +
    run.output_tokens * rate.output
  )
}
const sumKnown = (values: (number | null)[]) =>
  values.length && values.every((n) => n !== null)
    ? values.reduce<number>((sum, n) => sum + (n ?? 0), 0)
    : null
const taskEstimate = (job: Job) => {
  const runs = job.result.runs ?? []
  // An unreported claim still consumed work. Never present a partial retry history
  // as the cost of the whole task.
  for (let attempt = 0; attempt <= job.attempt; attempt++)
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
export function TaskUsage({ jobs }: { jobs: Job[] }) {
  const settled = jobs.filter((j) =>
    ["succeeded", "failed", "cancelled", "lost"].includes(j.status),
  )
  const runs = settled.flatMap((j) => j.result.runs ?? [])
  const compute = settled.flatMap((j) => j.result.compute ?? [])
  if (!runs.length && !compute.length) return null
  const completed = settled.filter((j) => j.status === "succeeded")
  const known = settled.filter((j) => j.cost_micro_usd !== null)
  const spend = known.reduce((n, j) => n + (j.cost_micro_usd ?? 0), 0)
  const estimatedTasks = settled.flatMap((j) => {
    const cost = taskEstimate(j)
    return cost === null ? [] : [{ job: j, cost }]
  })
  const estimatedCompleted = estimatedTasks.filter(({ job }) => job.status === "succeeded")
  const estimatedPerTask = estimatedCompleted.length
    ? estimatedCompleted.reduce((n, { cost }) => n + cost, 0) / estimatedCompleted.length
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
            "API estimate / task",
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
        {settled.length} loaded tasks · {measured.length}/{runs.length} model runs have token
        receipts · {known.length}/{settled.length} tasks report at least one dollar cost.
        {known.length < settled.length && " Plans do not report dollar spend."}
        {" Missing attempt costs stay unknown."}
        {estimatedCompleted.length > 0 &&
          ` API estimates cover ${estimatedCompleted.length} completed tasks, including their retries.`}
      </p>
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
                    API estimate / run
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
            Standard text rates, checked October 11, 2026. This compares measured tokens with API
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
            · API estimate: <span className="font-mono text-foreground">{dollars(estimated)}</span>
          </>
        )}
      </p>
      {runs.map((r, i) => (
        <p key={`${r.attempt}-${i}`} className="text-muted-foreground">
          Attempt {r.attempt + 1} · {r.model} · {Math.round(r.duration_ms / 1000)}s ·{" "}
          {r.input_tokens === null ? "Unknown input" : `${number(r.input_tokens)} input`} ·{" "}
          {r.output_tokens === null ? "Unknown output" : `${number(r.output_tokens)} output`}
          {r.cached_input_tokens !== null && ` · ${number(r.cached_input_tokens)} cached`}
          {r.skill && ` · Skill v${r.skill.version}`}
        </p>
      ))}
      {!runs.length && (
        <p className="text-muted-foreground">This runner has not reported token usage.</p>
      )}
      {(job.result.compute ?? []).map((c) => (
        <p key={c.turn} className="text-muted-foreground">
          {c.provider === "box" ? "Box" : "Ortam"} · compute stopped ·{" "}
          {c.billable_seconds === null
            ? "Unknown billable time"
            : `${number(c.billable_seconds)} billable seconds`}{" "}
          · {c.cost_micro_usd === null ? "Unknown cost" : dollars(c.cost_micro_usd)}
        </p>
      ))}
    </div>
  )
}

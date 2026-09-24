import type { SessionResult } from "./session"

/**
 * The editing-fuzz summary table. Signatures are number-free, so one bug is one row;
 * the repro seed is the failing session with the fewest edit gestures.
 */
export function summarize(results: SessionResult[]): string {
  const failed = results.filter((r) => !r.ok)
  const lines: string[] = []
  const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "–")
  const seeds = results.map((r) => r.seed).sort((a, b) => a - b)
  lines.push(
    `# Editing fuzz: ${results.length} sessions (seeds ${seeds[0]}–${seeds[seeds.length - 1]}), ${failed.length} failed (${pct(failed.length, results.length)})`,
    "",
  )

  const sum = (k: keyof SessionResult["stats"]) =>
    results.reduce((n, r) => n + (r.stats?.[k] ?? 0), 0)
  const withMoves = results.filter((r) => (r.stats?.reorderedSlides ?? 0) > 0)
  lines.push(
    `Exercised: ${sum("edits")} edits sent, ${sum("touchedSlides")} edited slides, ${withMoves.length} sessions with a real block reorder (${withMoves.filter((r) => r.ok).length} passed), ${results.filter((r) => r.arranged).length} Rearrange passes.`,
    "",
  )

  const byOracle = new Map<string, { sessions: Set<number>; count: number }>()
  for (const r of failed)
    for (const f of r.failures) {
      const row = byOracle.get(f.oracle) ?? { sessions: new Set(), count: 0 }
      row.sessions.add(r.seed)
      row.count++
      byOracle.set(f.oracle, row)
    }
  lines.push(
    "## Failures by oracle",
    "",
    "| oracle | failing sessions | findings |",
    "|---|---:|---:|",
  )
  for (const [oracle, row] of [...byOracle].sort((a, b) => b[1].sessions.size - a[1].sessions.size))
    lines.push(`| ${oracle} | ${row.sessions.size} | ${row.count} |`)
  lines.push("")

  const types = new Map<string, { with: number; failed: number }>()
  for (const r of results)
    for (const t of r.actionTypes) {
      const row = types.get(t) ?? { with: 0, failed: 0 }
      row.with++
      if (!r.ok) row.failed++
      types.set(t, row)
    }
  lines.push(
    "## Failures by action type (sessions that used it)",
    "",
    "| action | sessions | failed | fail rate |",
    "|---|---:|---:|---:|",
  )
  for (const [t, row] of [...types].sort(
    (a, b) => b[1].failed / b[1].with - a[1].failed / a[1].with,
  ))
    lines.push(`| ${t} | ${row.with} | ${row.failed} | ${pct(row.failed, row.with)} |`)
  lines.push("")

  const sigs = new Map<
    string,
    { oracle: string; phase: string; seeds: SessionResult[]; example: string }
  >()
  for (const r of failed)
    for (const f of r.failures) {
      const key = `${f.phase}|${f.oracle}|${f.signature}`
      const row = sigs.get(key) ?? {
        oracle: f.oracle,
        phase: f.phase,
        seeds: [],
        example: f.message,
      }
      if (!row.seeds.includes(r)) row.seeds.push(r)
      sigs.set(key, row)
    }
  lines.push(
    "## Distinct failure signatures",
    "",
    "| # | sessions | phase | oracle | signature | minimal repro seed | example |",
    "|---:|---:|---|---|---|---|---|",
  )
  const rows = [...sigs].sort((a, b) => b[1].seeds.length - a[1].seeds.length)
  rows.forEach(([key, row], i) => {
    const signature = key.split("|").slice(2).join("|")
    const best = [...row.seeds].sort(
      (a, b) =>
        Number(a.arranged) - Number(b.arranged) || a.editActions - b.editActions || a.seed - b.seed,
    )[0] as SessionResult
    const cell = (s: string) =>
      s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 160)
    lines.push(
      `| ${i + 1} | ${row.seeds.length} | ${row.phase} | ${row.oracle} | ${cell(signature)} | ${best.seed} (${best.editActions} gestures${best.arranged ? ", +arrange" : ""}) | ${cell(row.example)} |`,
    )
  })
  lines.push(
    "",
    "Replay one seed: `FUZZ_SEED=<seed> pnpm --filter @derive/web test:fuzz` (artifacts in test-results/fuzz/<seed>/).",
  )
  return lines.join("\n")
}

export function runtimeReport(meta: string | null): {
  report_short_id?: string
  save_status?: string
  released_at?: string
  outcome?: string
} | null {
  try {
    const value = JSON.parse(meta ?? "null")?.runtime
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    return {
      report_short_id:
        typeof value.report_short_id === "string" ? value.report_short_id : undefined,
      save_status: typeof value.save_status === "string" ? value.save_status : undefined,
      released_at: typeof value.released_at === "string" ? value.released_at : undefined,
      outcome: typeof value.outcome === "string" ? value.outcome : undefined,
    }
  } catch {
    return null
  }
}

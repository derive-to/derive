/**
 * Where an item a dashboard drill lists opens in Derive, by the dashboards model's source:
 * derive-dashboards' `itemLinks` templates, read by the web app and by agents' drill rows.
 * Every source that hangs off an artifact carries its short id in the item's key.
 */
export const DASHBOARD_ITEM_LINKS: Readonly<Record<string, string>> = {
  artifact: "/artifacts/{key.short_id}",
  version: "/artifacts/{key.artifact_short_id}",
  visit: "/artifacts/{key.artifact_short_id}",
  thread: "/artifacts/{key.artifact_short_id}",
  activity: "/artifacts/{key.artifact_short_id}",
  job: "/tasks/{key.id}",
}

import type { CodeDashboard, StoredQuery } from "derive-dashboards/core"

type Doc = CodeDashboard["document"]
type Widget = Doc["widgets"][string]
type Layout = Doc["tabs"][number]["layout"][number]
type Query = Omit<StoredQuery, "kind" | "source">

/** The range every built-in dashboard opens on. */
export const LAST_30 = { last: 30, unit: "day" as const, includeCurrent: true }

/** A source's aggregate query. */
export const ask = (source: string, more: Query): StoredQuery => ({
  kind: "aggregate",
  source,
  ...more,
})

/** A source's own time field over the dashboard's range. */
export const over = (source: string) => ({ dimension: `${source}.createdAt`, range: LAST_30 })

/** The same, compared with the period before: the number tile shows the change. */
export const againstBefore = (source: string) => ({
  ...over(source),
  compare: "previous_period" as const,
})

/** One measure entry. */
export const measure = (id: string, member: string) => ({ id, measure: member })

/** One equality filter, as a query or measure filter node. */
export const where = (id: string, member: string, value: string | number | boolean) => ({
  id,
  member,
  op: "equals" as const,
  values: [value],
})

/** Largest first, cut to `limit`. */
export const top = (by: string, limit: number) => ({
  order: [{ id: "o", by, dir: "desc" as const }],
  limit,
})

/** A number tile. */
export const number = (title: string, main: StoredQuery): Widget => ({
  kind: "number",
  title,
  queries: { main },
})

/** A share of a total, in percent points: `m_part` over `m_whole`, both entries of the query. */
export const share = (label: string) => ({
  calc: [
    {
      id: "c_share",
      formula: {
        op: "*" as const,
        args: [{ op: "/" as const, args: [{ ref: "m_part" }, { ref: "m_whole" }] }, { lit: 100 }],
      } as const,
      format: "percent" as const,
      label,
    },
  ],
})

/** The one control every built-in dashboard has: its range. Filters come from clicking the data. */
export const RANGE = {
  id: "range",
  label: "Range",
  kind: "date_range" as const,
  presets: [
    { last: 7, unit: "day" as const, includeCurrent: true },
    LAST_30,
    { last: 90, unit: "day" as const, includeCurrent: true },
  ],
}

/**
 * A dashboard of one tab: rows of tiles, each row's widths summing to 12. A row is laid out at
 * `height` grid units tall.
 */
export const dashboard = (
  key: string,
  title: string,
  description: string,
  rows: readonly {
    height: number
    tiles: readonly (readonly [id: string, width: number, widget: Widget])[]
  }[],
): CodeDashboard => {
  const layout: Layout[] = []
  const widgets: Record<string, Widget> = {}
  let y = 0
  for (const row of rows) {
    let x = 0
    for (const [id, w, widget] of row.tiles) {
      layout.push({ widget: id, x, y, w, h: row.height })
      widgets[id] = widget
      x += w
    }
    y += row.height
  }
  return {
    key,
    document: {
      specVersion: 1,
      meta: { title, description },
      tabs: [{ id: "main", title, layout }],
      widgets,
      controls: [RANGE],
      scope: { bySource: {} },
    },
  }
}

/** The link to an artifact in Derive, from a query entry holding its short id. */
export const artifactHref = (entry: string) => `/artifacts/{${entry}}`

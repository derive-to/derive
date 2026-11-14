import { dashboardTools } from "derive-dashboards/mcp"
import { describe, expect, it } from "vitest"
import { dashboardsFor } from "../src/dashboards"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

const owner: TestUser = { id: "u_dash_owner", email: "owner@dash.test", name: "Owner" }
const editor: TestUser = { id: "u_dash_editor", email: "editor@dash.test", name: "Editor" }
const WEB = "https://app.derive.test"
const { app, meta } = makeAuthedApp("dashboards", [owner, editor], undefined, {
  deps: { webOrigins: [WEB] },
})

/** One number from the dashboards' free query: versions published, as this person sees them. */
const versionsSeenBy = async (who: TestUser) => {
  const query = {
    kind: "aggregate",
    source: "version",
    measures: [{ id: "m0", measure: "version.count" }],
  }
  const r = await app.request("/v1/dashboards/query/run", jsonAs(as(who.email), { query }))
  expect(r.status).toBe(200)
  const answer = (await r.json()) as { rows: [[{ v: string }]] }
  return Number(answer.rows[0][0].v)
}

describe("dashboards", () => {
  it.runIf(meta.dashboards === undefined)("are not served without Postgres", async () => {
    const r = await app.request("/v1/dashboards/dashboards/list", { headers: as(owner.email) })
    expect(r.status).toBe(404)
  })

  it.runIf(meta.dashboards !== undefined)(
    "count only the artifacts each person can open, and answer the built-in Publishing dashboard",
    async () => {
      const shared = await (await publishAs(app, "<h1>Plan</h1>", {}, as(owner.email))).json()
      await publishAs(app, "<h1>Plan v2</h1>", {}, as(owner.email), shared.short_id)
      // The editor's own unlisted draft: theirs to count, nobody else's.
      await publishAs(app, "<h1>Private</h1>", {}, as(editor.email))

      expect(await versionsSeenBy(owner)).toBe(2)
      expect(await versionsSeenBy(editor)).toBeGreaterThanOrEqual(1)

      const listed = await app.request("/v1/dashboards/dashboards/list", {
        headers: as(owner.email),
      })
      const { dashboards } = (await listed.json()) as {
        dashboards: { id: string; title: string }[]
      }
      expect(dashboards.map((d) => d.title)).toContain("Publishing")

      const doc = await app.request(
        "/v1/dashboards/dashboards/get",
        jsonAs(as(owner.email), { dashboardId: "default:publishing" }),
      )
      const { document } = (await doc.json()) as { document: { widgets: Record<string, unknown> } }
      const tiles = Object.keys(document.widgets).map((widgetId) => ({ widgetId }))
      const streamed = await app.request(
        "/v1/dashboards/dashboards/tiles",
        jsonAs(as(owner.email), { dashboardId: "default:publishing", tiles }),
      )
      const lines = (await streamed.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { ok?: boolean; done?: true })
      expect(lines.at(-1)).toEqual({ done: true })
      expect(lines.filter((l) => l.ok === false)).toEqual([])
    },
  )

  it.runIf(meta.dashboards !== undefined)(
    "accept the web app's origin and refuse any other site's",
    async () => {
      const open = (origin: string) =>
        app.request(
          "/v1/dashboards/dashboards/get",
          jsonAs({ ...as(owner.email), origin }, { dashboardId: "default:publishing" }),
        )
      expect((await open(WEB)).status).toBe(200)
      expect((await open("https://elsewhere.example")).status).toBe(403)
    },
  )

  it.runIf(meta.dashboards !== undefined)("refuse someone signed out", async () => {
    const r = await app.request("/v1/dashboards/dashboards/list")
    expect(r.status).toBe(401)
  })

  it.runIf(meta.dashboards !== undefined)(
    "answer an agent's question through dashboards_query, for the person it acts for",
    async () => {
      await publishAs(app, "<h1>Notes</h1>", {}, as(owner.email))
      const dashboards = dashboardsFor({
        meta,
        deps: { baseUrl: "http://derive.test" },
        allowOrigins: new Set([WEB]),
      })
      if (!dashboards) throw new Error("Postgres serves dashboards")
      const [query] = dashboardTools(dashboards.server)
      const answered = await query?.run(
        { op: "ask", query: { source: "Version", measures: [{ id: "m0", measure: "Versions" }] } },
        {
          id: "ag_dash",
          tenant: { org: "default" },
          roles: ["editor"],
          attributes: {
            artifacts: (await meta.listArtifacts({ orgId: "default" })).map((a) => a.id),
          },
          agent: { for: owner.id },
        },
      )
      expect(answered?.isError).toBeUndefined()
      expect(answered?.content[0]?.text).toMatch(/\| Versions \|\n\| --- \|\n\| \d+ \|/)
    },
  )
})

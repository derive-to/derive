import { dashboardTools } from "derive-dashboards/mcp"
import { describe, expect, it } from "vitest"
import { createDashboards, dashboardsFor, dashboardsViewer } from "../src/dashboards"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

const owner: TestUser = { id: "u_dash_owner", email: "owner@dash.test", name: "Owner" }
const editor: TestUser = { id: "u_dash_editor", email: "editor@dash.test", name: "Editor" }
const commenter: TestUser = {
  id: "u_dash_commenter",
  email: "commenter@dash.test",
  name: "Commenter",
}
const WEB = "https://app.derive.test"
const { app, meta } = makeAuthedApp("dashboards", [owner, editor, commenter], undefined, {
  deps: { webOrigins: [WEB] },
})

/** One number from the dashboards' free query: versions published, as this person sees them. */
const versionsSeenBy = async (who: TestUser) => {
  const query = {
    kind: "aggregate",
    source: "version",
    measures: [{ id: "m1", measure: "version.count" }],
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

      expect(dashboards.map((d) => d.title)).toEqual(
        expect.arrayContaining(["Publishing", "Reading", "Agents", "Workspace health"]),
      )
      for (const key of ["publishing", "reading", "agents", "health"]) {
        const dashboardId = `default:${key}`
        const doc = await app.request(
          "/v1/dashboards/dashboards/get",
          jsonAs(as(owner.email), { dashboardId }),
        )
        const { document } = (await doc.json()) as {
          document: { widgets: Record<string, unknown> }
        }
        const tiles = Object.keys(document.widgets).map((widgetId) => ({ widgetId }))
        const streamed = await app.request(
          "/v1/dashboards/dashboards/tiles",
          jsonAs(as(owner.email), { dashboardId, tiles }),
        )
        const lines = (await streamed.text())
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as { ok?: boolean; done?: true; result?: { drill?: unknown } },
          )
        expect(lines.at(-1), key).toEqual({ done: true })
        expect(
          lines.filter((l) => l.ok === false),
          key,
        ).toEqual([])
        // Derive turns drill-in on: a member's tiles come back with what a click opens.
        expect(
          lines.some((l) => l.result?.drill !== undefined),
          key,
        ).toBe(true)
      }
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

  it.runIf(meta.dashboards !== undefined)(
    "show who read what only to a seat that may publish",
    async () => {
      const seat = await meta.getMembership("default", commenter.id)
      await meta.setMembership({
        id: seat?.id ?? "m_dash_commenter",
        org_id: "default",
        user_id: commenter.id,
        role: "commenter",
      })
      const query = {
        kind: "aggregate",
        source: "visit",
        measures: [{ id: "m1", measure: "visit.readers" }],
        dimensions: [{ id: "d1", member: "visit.reader" }],
      }
      const asOwner = await app.request(
        "/v1/dashboards/query/run",
        jsonAs(as(owner.email), { query }),
      )
      expect(asOwner.status).toBe(200)
      const asCommenter = await app.request(
        "/v1/dashboards/query/run",
        jsonAs(as(commenter.email), { query }),
      )
      expect(asCommenter.status).toBe(403)
    },
  )

  it.runIf(meta.dashboards !== undefined)(
    "count the built-in agent's runs only for the person who asked, as the runs page does",
    async () => {
      await meta.createJob({
        id: "job_dash_private",
        org_id: "default",
        agent_id: "derive",
        kind: "ask",
        instruction: "Summarize my notes",
        asked_by: editor.id,
        attended: 1,
      })
      const runsSeenBy = async (who: TestUser, measure = "job.count") => {
        const query = { kind: "aggregate", source: "job", measures: [{ id: "m1", measure }] }
        const r = await app.request("/v1/dashboards/query/run", jsonAs(as(who.email), { query }))
        const answer = (await r.json()) as { rows: [[{ v: string }]] }
        return Number(answer.rows[0][0].v)
      }
      expect(await runsSeenBy(editor)).toBe(1)
      expect(await runsSeenBy(owner)).toBe(0)
      // A run waiting on its asker counts as waiting.
      await meta.updateJob("job_dash_private", { status: "needs_you" })
      expect(await runsSeenBy(editor, "job.waiting")).toBe(1)
    },
  )

  it.runIf(meta.dashboards !== undefined)(
    "open a page cursor one replica issued on another that shares the deployment's secret",
    async () => {
      await publishAs(app, "<h1>One</h1>", {}, as(owner.email))
      await publishAs(app, "<h1>Two</h1>", {}, as(owner.email))
      const replica = () =>
        createDashboards({ meta, trustedOrigins: [], secret: "derive dashboards\u0000shared" })
      const [first, second] = [replica(), replica()]
      if (!first || !second) throw new Error("Postgres serves dashboards")
      const artifacts = (await meta.listArtifacts({ orgId: "default" })).map((a) => a.id)
      const viewer = dashboardsViewer({
        userId: owner.id,
        orgId: "default",
        role: "owner",
        artifacts,
      })
      const query = {
        kind: "aggregate" as const,
        source: "version",
        measures: [{ id: "m1" as const, measure: "version.count" }],
      }
      const page1 = await first.server.api.queryRecords({ body: { query, limit: 1 }, viewer })
      expect(page1.next).toBeDefined()
      const page2 = await second.server.api.queryRecords({
        body: { query, limit: 1, after: page1.next ?? "" },
        viewer,
      })
      expect(page2.rows).toHaveLength(1)
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

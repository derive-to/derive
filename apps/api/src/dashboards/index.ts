import { type MetaStore, type Role, roleAllows } from "@derive/core"
import { deriveDashboards } from "derive-dashboards"
import type { Viewer } from "derive-dashboards/core"
import { trustedWebOrigins } from "../auth-config"
import { dashboardsModel } from "./model"
import { PUBLISHING } from "./publishing"

/** Where the dashboards' endpoints are mounted (the web client calls the same path). */
export const DASHBOARDS_PATH = "/v1/dashboards"

/**
 * The workspace's dashboards, on Postgres (`MetaStore.dashboards`); none on SQLite and D1.
 *
 * Derive decides who is asking (its session, workspace and seat), then hands the library a
 * viewer for that one request: the person, their workspace as the tenant, their seat as the
 * role, and the ids of the artifacts they can open. `viewerFor` keeps it beside the request,
 * so nothing the library does re-derives identity on its own.
 */
export const createDashboards = ({ meta, trustedOrigins }: DashboardsHost) => {
  const backend = meta.dashboards
  if (!backend) return null
  const viewers = new WeakMap<Request, WorkspaceViewer>()
  const server = deriveDashboards({
    model: dashboardsModel,
    basePath: DASHBOARDS_PATH,
    trustedOrigins,
    viewer: (request) => viewers.get(request) ?? null,
    access: {
      // Every member views; a seat that may publish edits and makes dashboards; owners manage.
      can: (viewer, verb) => {
        const role = viewer.roles?.[0] as Role | undefined
        if (!role) return false
        if (verb === "view") return true
        return roleAllows(role, verb === "manage" ? "manage" : "publish")
      },
    },
    connections: { main: backend.connection },
    database: backend.store,
    dashboards: [PUBLISHING],
  })
  return {
    server,
    /** Answers one request as this viewer. */
    handle: (request: Request, viewer: WorkspaceViewer) => {
      viewers.set(request, viewer)
      return server.handler(request)
    },
  }
}

export type Dashboards = NonNullable<ReturnType<typeof createDashboards>>

/** What the dashboards server needs from the app: its store and the web origins it trusts. */
type DashboardsHost = { meta: MetaStore; trustedOrigins: string[] }

const built = new WeakMap<MetaStore, Dashboards | null>()

/**
 * One dashboards server per store, shared by the routes and the MCP tools. The web app may
 * live on another origin than the API, so its POSTs are trusted by the same list as sign-in.
 */
export const dashboardsFor = (ctx: {
  meta: MetaStore
  deps: { baseUrl: string }
  allowOrigins: ReadonlySet<string>
}): Dashboards | null => {
  if (!built.has(ctx.meta)) {
    const trustedOrigins = trustedWebOrigins(ctx.deps.baseUrl, [...ctx.allowOrigins])
    built.set(ctx.meta, createDashboards({ meta: ctx.meta, trustedOrigins }))
  }
  return built.get(ctx.meta) ?? null
}

/** A viewer in one workspace: the workspace is always its tenant. */
export type WorkspaceViewer = Viewer & { tenant: { org: string } }

/** The viewer a person is, in a workspace, for the library. */
export const dashboardsViewer = (a: {
  userId: string
  orgId: string
  role: Role
  artifacts: string[]
}): WorkspaceViewer => ({
  id: a.userId,
  tenant: { org: a.orgId },
  roles: [a.role],
  attributes: { artifacts: a.artifacts },
})

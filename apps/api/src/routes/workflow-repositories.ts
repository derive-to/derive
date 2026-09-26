import {
  GITHUB_REPOSITORY_PATTERN,
  readWorkflowRepositories,
  type WorkflowRepository,
  workflowRepositories,
} from "@derive/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { bearerFor } from "../lib/broker"
import { manageableContext } from "../lib/context-access"
import { fail, readJson } from "../lib/http"

/** Repository selection delegates an existing workspace installation, never a pasted token. */
export function workflowRepositoryRoutes(ctx: AppContext) {
  const app = new Hono()
  app.get("/v1/workflow-runtimes/:id/repositories", async (c) => {
    c.header("Cache-Control", "no-store")
    const org = await ctx.requireWorkspace(c, "manage")
    if (org instanceof Response) return org
    const context = await manageableContext(ctx, c)
    if (context instanceof Response) return context
    const connection = await ctx.meta.getConnection(c.req.query("connection_id") ?? "")
    if (
      !connection ||
      connection.org_id !== org ||
      connection.kind !== "github_app" ||
      connection.scope !== "workspace" ||
      connection.status !== "active"
    )
      return fail(c, 400, "Choose an active workspace GitHub connection")
    if (!ctx.deps.encryptionKey) return fail(c, 503, "GitHub is unavailable")
    const page = c.req.query("page") ?? "1"
    if (!/^[1-9][0-9]{0,4}$/.test(page)) return fail(c, 400, "Invalid page")
    try {
      const token = await bearerFor(ctx.meta, connection, ctx.deps.encryptionKey)
      const response = await fetch(
        `${connection.base_url}/installation/repositories?per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "derive/1",
          },
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        },
      )
      if (!response.ok) return fail(c, 502, "Could not list the GitHub installation’s repositories")
      const data = (await response.json()) as {
        repositories: { id: number; full_name: string }[]
        total_count: number
      }
      return c.json({
        repositories: data.repositories.map((r) => ({ id: r.id, repository: r.full_name })),
        next_page: Number(page) * 100 < data.total_count ? Number(page) + 1 : null,
      })
    } catch {
      return fail(c, 502, "GitHub is unavailable. Check the connection in Settings → Integrations.")
    }
  })
  app.put("/v1/workflow-runtimes/:id/repositories", async (c) => {
    const org = await ctx.requireWorkspace(c, "manage")
    if (org instanceof Response) return org
    const context = await manageableContext(ctx, c)
    if (context instanceof Response) return context
    const user = await ctx.managementPrincipal(c)
    if (!user) return fail(c, 401, "unauthenticated")
    const body = await readJson(
      c,
      z
        .object({
          revision: z.number().int().nonnegative(),
          repositories: z
            .array(
              z
                .object({
                  connection_id: z.string().min(1).max(64),
                  repository: z.string().regex(GITHUB_REPOSITORY_PATTERN),
                  access: z.enum(["read", "write"]).default("read"),
                })
                .strict(),
            )
            .max(10),
        })
        .strict(),
    )
    if (body instanceof Response) return body
    if (context.repository_revision !== body.revision)
      return fail(c, 409, "Repository access changed. Reload before saving.")
    const existing = readWorkflowRepositories(context.repository_bindings)
    const grants: WorkflowRepository[] = []
    for (const selected of body.repositories) {
      // Retaining or reducing an existing grant must work even when GitHub is unavailable.
      // A revoked connection still fails the live run gate; only new authority needs verification.
      const previous = existing.find(
        (r) =>
          r.connection_id === selected.connection_id &&
          r.repository.toLowerCase() === selected.repository.toLowerCase(),
      )
      if (previous && (previous.access === selected.access || selected.access === "read")) {
        grants.push({ ...previous, access: selected.access })
        continue
      }
      const connection = await ctx.meta.getConnection(selected.connection_id)
      if (
        !connection ||
        connection.org_id !== org ||
        connection.kind !== "github_app" ||
        connection.scope !== "workspace" ||
        connection.status !== "active"
      )
        return fail(c, 400, "Choose an active workspace GitHub connection")
      if (!ctx.deps.encryptionKey) return fail(c, 503, "GitHub is unavailable")
      if (selected.repository.split("/").some((p) => p === "." || p === ".."))
        return fail(c, 400, "Invalid repository")
      try {
        const token = await bearerFor(ctx.meta, connection, ctx.deps.encryptionKey)
        const response = await fetch(`${connection.base_url}/repos/${selected.repository}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "derive/1",
          },
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        })
        if (!response.ok)
          return fail(
            c,
            400,
            "Repository unavailable. Check the installation’s selected repositories.",
          )
        const repository = (await response.json()) as { id: number; full_name: string }
        const grant = workflowRepositories([
          {
            ...selected,
            repository: repository.full_name,
            repository_id: repository.id,
            installation_id: connection.broker_ref,
          },
        ])[0]
        if (!grant) return fail(c, 400, "Invalid repository")
        // Prove this installation has both the repository and the requested permission.
        await bearerFor(
          ctx.meta,
          connection,
          ctx.deps.encryptionKey,
          selected.access === "write" ? "contents-write" : "contents-read",
          grant.repository_id,
        )
        if (selected.access === "write")
          await bearerFor(
            ctx.meta,
            connection,
            ctx.deps.encryptionKey,
            "pr-comment",
            grant.repository_id,
          )
        grants.push(grant)
      } catch {
        return fail(
          c,
          400,
          "GitHub repository access is unavailable. In Settings → Integrations, check selected repositories and approve Contents access (and Pull requests write for write access).",
        )
      }
    }
    try {
      workflowRepositories(grants)
    } catch {
      return fail(c, 400, "Choose each repository once")
    }
    const saved = await ctx.meta.saveWorkflowRepositories({
      contextId: context.id,
      orgId: org,
      ownerId: user,
      repositories: grants,
      revision: body.revision,
    })
    if (!saved) return fail(c, 409, "Repository access changed. Reload before saving.")
    return c.json({
      repositories: readWorkflowRepositories(saved.repository_bindings),
      repository_revision: saved.repository_revision,
    })
  })
  return app
}

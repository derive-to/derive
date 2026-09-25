import { artifactUserCan, isBundleContentType, newId, publish } from "@derive/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { afterPublish } from "../lib/after-publish"
import { parseConnectionIds } from "../lib/broker"
import { manageableContext } from "../lib/context-access"
import { ContextConflictError, createContextCore } from "../lib/create-context"
import { sha256 } from "../lib/crypto"
import { fail, readJson } from "../lib/http"
import { deleteArtifactAndUnindex } from "../lib/search"
import { workflowFileManifest } from "../lib/workflow-files"
import { workflowConfiguration, workflowReadiness } from "../lib/workflow-readiness"

/** A workflow view over existing execution records; Context and artifact contracts stay intact. */
export const workflowRuntimeRoutes = (ctx: AppContext) => {
  const app = new Hono()
  app.get("/v1/workflow-runtimes", async (c) => {
    c.header("Cache-Control", "no-store")
    const org = await ctx.requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const user = await ctx.managementPrincipal(c)
    if (!user) return fail(c, 401, "unauthenticated")
    const available = !!ctx.deps.runtime?.managed?.workspaceIds.has(org)
    const canRun = await ctx.workspaceCan(c, "publish")
    const rows = await ctx.meta.contextsWithManifests(org)
    const items = []
    for (const context of rows) {
      if (context.import_source || !(await ctx.canUserAskContext(user, context))) continue
      const [binding, runtime, setup] = await Promise.all([
        ctx.meta.getRuntimeModelBinding(context.id, org),
        ctx.meta.getContextRuntimeForContext(context.id, org),
        ctx.meta.getRuntimeSetup(context.id, org),
      ])
      if (!binding && !runtime && !setup && !(await ctx.meta.getWorkflowDraft(context.id, org)))
        continue

      // Operator machines are never exposed through the managed cloud workflow view.
      if ((runtime && runtime.connection_id !== null) || (setup && setup.connection_id !== null))
        continue
      const schedule = runtime ? await ctx.meta.getRuntimeSchedule(runtime.id, org) : null
      const readiness = await workflowReadiness(
        ctx.meta,
        ctx.deps.runtime,
        context,
        user,
        ctx.deps.runtimeFetch,
      )
      items.push({
        id: context.id,
        name: context.name,
        created_at: context.created_at,
        disabled: !!runtime?.disabled_at,
        preparing: readiness.state === "preparing",
        ready: readiness.state === "ready",
        can_open: true,
        readiness,
        schedule: schedule
          ? {
              enabled: !!schedule.enabled,
              trigger: JSON.parse(schedule.trigger) as { kind: string; cron?: string; tz?: string },
            }
          : null,
      })
    }
    return c.json({ available, can_create: available && canRun, items })
  })
  app.post("/v1/workflow-runtimes", async (c) => {
    const org = await ctx.requireWorkspace(c, "publish")
    if (org instanceof Response) return org
    const user = await ctx.managementPrincipal(c)
    if (!user) return fail(c, 401, "unauthenticated")
    if (!ctx.deps.runtime?.managed?.workspaceIds.has(org))
      return fail(c, 403, "Cloud execution is not available in this workspace")
    const limited = await ctx.limited(c, ctx.publishLimiter)
    if (limited) return limited
    const body = await readJson(
      c,
      z.object({
        name: z.string().trim().min(1).max(80),
        model_connection_id: z.string().min(1).max(64).optional(),
        request_id: z.string().uuid().optional(),
      }),
    )
    if (body instanceof Response) return body
    const contextId = body.request_id
      ? `ctx_${sha256(JSON.stringify([org, user, body.request_id])).slice(0, 40)}`
      : newId("ctx")
    const existing = await ctx.meta.getContext(contextId)
    if (existing?.org_id === org && existing.created_by === user) {
      // Repair a request interrupted between Context creation and draft persistence.
      // Never overwrite an existing draft, established schedule or account grant.
      if (!(await ctx.meta.getContextRuntimeForContext(existing.id, org))) {
        await ctx.meta.saveWorkflowDraft({
          contextId: existing.id,
          orgId: org,
          ownerId: user,
          instruction: "",
          provider: "codex",
          revision: null,
          at: new Date().toISOString(),
        })
      }
      return c.json({ id: existing.id }, 200)
    }
    const connection = body.model_connection_id
      ? await ctx.meta.getRuntimeModelConnection(body.model_connection_id, org)
      : null
    if (
      body.model_connection_id &&
      (!connection ||
        connection.created_by !== user ||
        connection.revoked_at ||
        connection.api_url !== ctx.deps.runtime.apiUrl)
    )
      return fail(c, 400, "Choose one of your available model accounts")
    const bytes = new TextEncoder().encode(
      "Follow the instructions supplied for each workflow run. Use only the selected tools and access. Produce a clear report of the outcome.\n",
    )
    if (await ctx.overStorage(org, bytes.length))
      return fail(c, 402, "Workspace storage limit reached")
    const published = await publish(ctx.meta, ctx.blobs, {
      bytes,
      filename: "manifest.md",
      isBundle: false,
      orgId: org,
      title: `${body.name} — instructions`,
      authorId: user,
      source: "web",
      workspaceAccess: "none",
      linkRole: "none",
      listed: "none",
    })
    try {
      await ctx.meta.setArtifactMember({
        id: newId("am"),
        artifact_id: published.artifact.id,
        user_id: user,
        role: "owner",
      })
      const { context } = await createContextCore(ctx.meta, {
        contextId,
        orgId: org,
        userId: user,
        name: body.name,
        manifestArtifactId: published.artifact.id,
      })
      await ctx.meta.saveWorkflowDraft({
        contextId: context.id,
        orgId: org,
        ownerId: user,
        instruction: "",
        provider: connection?.provider ?? "codex",
        revision: null,
        at: new Date().toISOString(),
      })
      const binding = connection
        ? await ctx.meta.saveRuntimeModelBinding({
            contextId: context.id,
            orgId: org,
            ownerId: user,
            connectionId: connection.id,
            revision: null,
            at: new Date().toISOString(),
          })
        : true
      if (!binding) {
        await ctx.meta.deleteContext(context.id, org)
        await ctx.meta.deleteAgent(context.agent_id, org)
        await deleteArtifactAndUnindex(ctx.meta, ctx.search, published.artifact.id, org)
        return fail(c, 409, "Model account access changed; choose an available account")
      }
      await afterPublish(ctx, published.artifact, published.version, {
        isNew: true,
        onBehalf: user,
        actorId: user,
      })
      return c.json({ id: context.id }, 201)
    } catch (error) {
      if (!(error instanceof ContextConflictError)) throw error
      await deleteArtifactAndUnindex(ctx.meta, ctx.search, published.artifact.id, org)
      const replay = await ctx.meta.getContext(contextId)
      if (replay?.org_id === org && replay.created_by === user)
        return c.json({ id: replay.id }, 200)
      return fail(c, 409, "A workflow or Context with that name already exists")
    }
  })
  // Reading a draft remains possible when execution rollout or consent is unavailable.
  app.get("/v1/workflow-runtimes/:id", async (c) => {
    c.header("Cache-Control", "no-store")
    const org = await ctx.requireWorkspace(c, "read")
    if (org instanceof Response) return org
    const user = await ctx.managementPrincipal(c)
    const context = await ctx.meta.getContext(c.req.param("id"))
    if (
      !user ||
      !context ||
      context.org_id !== org ||
      !(await ctx.canUserAskContext(user, context))
    )
      return fail(c, 404, "not found")
    const configuration = await workflowConfiguration(ctx.meta, context)
    const files = await ctx.meta.getWorkflowFiles(context.id, org)
    const source = files?.artifact_id ? await ctx.meta.getArtifactById(files.artifact_id) : null
    return c.json({
      draft: configuration.schedule ? null : configuration.draft,
      schedule: configuration.schedule,
      connection_ids: parseConnectionIds(context.connection_ids),
      files: files
        ? { ...files, title: source?.title ?? "Input files", short_id: source?.short_id }
        : null,
      test: await ctx.meta
        .latestWorkflowTest(context.id, org, user)
        .then((value) => value && { id: value.id, status: value.status }),
      readiness: await workflowReadiness(
        ctx.meta,
        ctx.deps.runtime,
        context,
        user,
        ctx.deps.runtimeFetch,
      ),
    })
  })
  app.put("/v1/workflow-runtimes/:id/files", async (c) => {
    const org = await ctx.requireWorkspace(c, "publish")
    if (org instanceof Response) return org
    const context = await manageableContext(ctx, c)
    if (context instanceof Response) return context
    const user = await ctx.managementPrincipal(c)
    if (!user) return fail(c, 401, "unauthenticated")
    const body = await readJson(
      c,
      z
        .object({
          short_id: z.string().min(1).max(64).nullable(),
          version: z.number().int().positive().nullable(),
          revision: z.number().int().nonnegative().nullable(),
        })
        .strict(),
    )
    if (body instanceof Response) return body
    if ((body.short_id === null) !== (body.version === null))
      return fail(c, 400, "Choose an artifact version or remove the attachment")
    let artifactId: string | null = null
    let blobKey: string | null = null
    if (body.short_id && body.version) {
      const artifact = await ctx.meta.getByShortId(body.short_id)
      if (
        !artifact ||
        artifact.org_id !== org ||
        artifact.removed_at ||
        artifact.archived_at ||
        !(await artifactUserCan(ctx.meta, user, "share", artifact))
      )
        return fail(c, 403, "You need permission to share these files with the workflow")
      const version = await ctx.meta.getVersion(artifact.id, body.version)
      if (!version || !isBundleContentType(version.content_type))
        return fail(c, 400, "Choose an uploaded file bundle")
      artifactId = artifact.id
      blobKey = version.blob_key
      try {
        await workflowFileManifest(ctx.blobs, {
          artifact_id: artifact.id,
          version: version.n,
          blob_key: version.blob_key,
          granted_by: user,
          revision: 0,
        })
      } catch {
        return fail(c, 400, "The bundle contains unavailable or unsupported files")
      }
    }
    const files = await ctx.meta.saveWorkflowFiles({
      contextId: context.id,
      orgId: org,
      ownerId: user,
      artifactId,
      blobKey,
      version: body.version,
      revision: body.revision,
      at: new Date().toISOString(),
    })
    if (!files) return fail(c, 409, "The file attachment changed. Reload before saving.")
    return c.json({ files })
  })
  app.put("/v1/workflow-runtimes/:id", async (c) => {
    const org = await ctx.requireWorkspace(c, "publish")
    if (org instanceof Response) return org
    const context = await manageableContext(ctx, c)
    if (context instanceof Response) return context
    const body = await readJson(
      c,
      z.object({
        instruction: z.string().max(16000),
        provider: z.enum(["codex", "claude-code"]),
        revision: z.number().int().min(0).nullable(),
      }),
    )
    if (body instanceof Response) return body
    const user = await ctx.managementPrincipal(c)
    if (!user) return fail(c, 401, "unauthenticated")
    const draft = await ctx.meta.saveWorkflowDraft({
      contextId: context.id,
      orgId: context.org_id,
      ownerId: user,
      ...body,
      at: new Date().toISOString(),
    })
    if (!draft)
      return fail(
        c,
        409,
        "Configuration changed elsewhere. Reload before saving; your unsaved edits are preserved.",
      )
    return c.json({ draft })
  })
  app.post("/v1/workflow-runtimes/:id/tests", async (c) => {
    const org = await ctx.requireWorkspace(c, "publish")
    if (org instanceof Response) return org
    const user = await ctx.managementPrincipal(c)
    const context = await ctx.meta.getContext(c.req.param("id"))
    if (
      !user ||
      !context ||
      context.org_id !== org ||
      !(await ctx.canUserAskContext(user, context))
    )
      return fail(c, 404, "not found")
    const body = await readJson(
      c,
      z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/), request_id: z.string().uuid() }),
    )
    if (body instanceof Response) return body
    const id = `run_${sha256(JSON.stringify([org, user, context.id, body.request_id])).slice(0, 40)}`
    const prior = await ctx.meta.getWorkflowTest(id, org)
    if (prior)
      return prior.config_revision === body.revision
        ? c.json({ request: { id: prior.id, status: prior.status } }, 200)
        : fail(c, 409, "This test request used a different configuration")
    const readiness = await workflowReadiness(
      ctx.meta,
      ctx.deps.runtime,
      context,
      user,
      ctx.deps.runtimeFetch,
    )
    if (readiness.revision !== body.revision)
      return fail(c, 409, "Configuration changed. Review it before testing.")
    if (!readiness.can_test)
      return fail(c, 409, readiness.blockers[0]?.message ?? "A test is already being prepared", {
        readiness,
      })
    const configuration = await workflowConfiguration(ctx.meta, context)
    if (!configuration.input || configuration.revision !== body.revision)
      return fail(c, 409, "Configuration changed. Review it before testing.")
    const request = await ctx.meta.createWorkflowTest(
      {
        id,
        context_id: context.id,
        org_id: org,
        initiated_by: user,
        config_revision: body.revision,
        input_snapshot: JSON.stringify(configuration.input),
      },
      new Date().toISOString(),
    )
    if (!request) return fail(c, 409, "A test is already being prepared for this workflow")
    ctx.deps.pokeRuntime?.()
    return c.json({ request: { id: request.id, status: request.status } }, 202)
  })
  return app
}

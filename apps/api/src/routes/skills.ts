import {
  type ArtifactSkillRole,
  LINKED_BUNDLE_FACT,
  newId,
  parseFrontmatter,
  publish,
  SKILL_CONTENT_TYPE,
  SKILL_SIDECAR_PATH,
  type SkillClient,
  type SkillInstallPolicy,
  type SkillInstallScope,
  toJson,
  validateSkillDefinition,
  WORKFLOW_DEFINITION_FACT,
} from "@derive/core"
import { OpenAPIHono } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import { z } from "zod"
import type { AppContext } from "../context"
import { afterPublish } from "../lib/after-publish"
import { manifestOf, mergeBundleZip, pageTextResolver, zipBundleFiles } from "../lib/bundle"
import { ContextConflictError, createContextCore } from "../lib/create-context"
import { fail, readJson } from "../lib/http"
import { visibleArtifactIds } from "../lib/visibility"
import { parseLinkedWorkflowFacts } from "../lib/workflow-facts"

const installationBody = z.object({
  skill_version: z.number().int().positive(),
  scope_kind: z.enum(["project", "personal", "runner"]),
  opaque_scope_id: z.string().min(16).max(128),
  client: z.enum(["claude", "codex"]),
  digest: z.string().regex(/^[a-f0-9]{64}$/i),
  policy: z.enum(["pinned", "latest"]),
  removed: z.boolean().optional(),
})

const artifactLinkBody = z.object({
  artifact_version: z.number().int().positive(),
  skill_short_id: z.string().min(1),
  skill_version: z.number().int().positive(),
  role: z.enum([
    "created",
    "revised",
    "validated",
    "example",
    "anti-example",
    "workflow-definition",
  ]),
})

/** Skill catalog, graph, usage, installation receipts, and exact-version provenance. */
export const skillRoutes = (ctx: AppContext) => {
  const {
    meta,
    blobs,
    currentUser,
    agentFor,
    isToken,
    activeWorkspace,
    membershipOf,
    requireArtifact,
    authorize,
    actingHuman,
    actingUser,
    requireWorkspace,
    bus,
    notify,
    notifyRender,
    background,
    search,
    summarize,
    deps,
  } = ctx
  const app = new OpenAPIHono<BlankEnv>()

  const skillDefinition = async (artifactId: string, version: number) => {
    const row = await meta.getVersion(artifactId, version)
    if (!row || row.content_type !== SKILL_CONTENT_TYPE) return null
    const manifest = await manifestOf(blobs, row)
    if (!manifest) return null
    const text = await pageTextResolver(blobs, row)
    const checked = validateSkillDefinition(
      (await text("/SKILL.md")) ?? "",
      await text(SKILL_SIDECAR_PATH),
    )
    return checked.errors.length === 0 ? checked : null
  }

  app.get("/v1/skills", async (c) => {
    const me = await currentUser(c)
    const agent = me ? null : await agentFor(c)
    if (!me && !agent && !isToken(c)) return fail(c, 401, "unauthenticated")
    const orgId = await activeWorkspace(c)
    const memberId = me?.id ?? agent?.created_by ?? agent?.id
    const member = memberId ? await membershipOf(c, orgId, memberId) : null
    const operator = isToken(c)
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 30))
    const visible = []
    const pageSize = Math.min(100, Math.max(20, limit * 2))
    let cursor: { key: string; id: string } | undefined
    while (visible.length <= limit) {
      // catalog:false is definition state inside the immutable bundle, not artifact
      // metadata. Page the typed rows until we have enough visible definitions; a large
      // set of embedded Context Skills must never crowd an older shared Skill out.
      const rows = await meta.listArtifacts({
        orgId,
        limit: pageSize,
        cursor,
        q: c.req.query("query")?.trim().slice(0, 200) || undefined,
        contentType: SKILL_CONTENT_TYPE,
        publicOnly: !(operator || member),
        viewerId: operator ? undefined : memberId,
        excludeRemoved: true,
      })
      for (const row of rows) {
        const definition = await skillDefinition(row.id, row.current_version)
        if (!definition || definition.sidecar?.catalog === false) continue
        visible.push({
          ...toJson(deps.baseUrl, row, []),
          skill: {
            name: definition.metadata?.name ?? row.title ?? row.short_id,
            description: definition.metadata?.description ?? "",
            runtime: definition.sidecar?.runtime?.kind ?? "single",
          },
        })
        if (visible.length > limit) break
      }
      const last = rows.at(-1)
      if (visible.length > limit || rows.length < pageSize || !last) break
      cursor = { key: last.created_at, id: last.id }
    }
    return c.json({
      skills: visible.slice(0, limit),
      has_more: visible.length > limit,
    })
  })

  app.get("/v1/artifacts/:shortId/skill-graph", async (c) => {
    const skill = await requireArtifact(c, "read")
    if (skill instanceof Response) return skill
    if (skill.current_content_type !== SKILL_CONTENT_TYPE) return fail(c, 404, "not a skill")
    const relations = await meta.listSkillRelations(skill.id, skill.org_id)
    const ids = [...new Set(relations.flatMap((r) => [r.source_artifact_id, r.target_artifact_id]))]
    const candidates = await meta.listArtifacts({ ids, orgId: skill.org_id, archived: "include" })
    const readable = new Map<string, (typeof candidates)[number]>()
    for (const artifact of candidates) {
      if (await authorize(c, "read", artifact)) readable.set(artifact.id, artifact)
    }
    const currentRelations = relations.filter((relation) => {
      if (relation.source_artifact_id === skill.id)
        return relation.source_version === skill.current_version
      const source = readable.get(relation.source_artifact_id)
      return (
        relation.target_artifact_id === skill.id &&
        relation.target_version === skill.current_version &&
        source?.current_version === relation.source_version
      )
    })
    return c.json({
      root: skill.id,
      nodes: [...readable.values()].map((a) => ({
        id: a.id,
        short_id: a.short_id,
        title: a.title,
        version: a.current_version,
      })),
      edges: currentRelations.filter(
        (r) => readable.has(r.source_artifact_id) && readable.has(r.target_artifact_id),
      ),
    })
  })

  app.get("/v1/artifacts/:shortId/skill-usage", async (c) => {
    const skill = await requireArtifact(c, "read")
    if (skill instanceof Response) return skill
    if (skill.current_content_type !== SKILL_CONTENT_TYPE) return fail(c, 404, "not a skill")
    const [usage, installations, links] = await Promise.all([
      meta.skillUsage(skill.id, skill.org_id),
      meta.listSkillInstallations(skill.id, skill.org_id),
      meta.listSkillArtifactLinks(skill.id, skill.org_id, 100),
    ])
    const linked = await meta.listArtifacts({
      ids: [...new Set(links.map((l) => l.artifact_id))],
      orgId: skill.org_id,
      archived: "include",
    })
    const readable = new Set<string>()
    for (const artifact of linked)
      if (await authorize(c, "read", artifact)) readable.add(artifact.id)
    const installSummary = new Map<
      string,
      { client: SkillClient; scope_kind: SkillInstallScope; count: number; last_synced_at: string }
    >()
    for (const installation of installations) {
      if (installation.removed_at) continue
      const key = `${installation.client}:${installation.scope_kind}`
      const current = installSummary.get(key)
      installSummary.set(key, {
        client: installation.client,
        scope_kind: installation.scope_kind,
        count: (current?.count ?? 0) + 1,
        last_synced_at:
          !current || installation.updated_at > current.last_synced_at
            ? installation.updated_at
            : current.last_synced_at,
      })
    }
    return c.json({
      contexts: usage.contexts,
      workflows: usage.workflows,
      installations: [...installSummary.values()],
      artifacts: links
        .filter((link) => readable.has(link.artifact_id))
        .map((link) => {
          const artifact = linked.find((candidate) => candidate.id === link.artifact_id)
          return {
            ...link,
            artifact: artifact ? { short_id: artifact.short_id, title: artifact.title } : null,
          }
        }),
    })
  })

  app.put("/v1/artifacts/:shortId/skill-installation", async (c) => {
    const skill = await requireArtifact(c, "read")
    if (skill instanceof Response) return skill
    const body = await readJson(c, installationBody)
    if (body instanceof Response) return body
    const definition = await skillDefinition(skill.id, body.skill_version)
    if (!definition) return fail(c, 400, "skill version not found")
    const actor = (await actingHuman(c)) ?? (await actingUser(c))
    const now = new Date().toISOString()
    const installation = await meta.upsertSkillInstallation({
      id: newId("ski"),
      org_id: skill.org_id,
      skill_artifact_id: skill.id,
      skill_version: body.skill_version,
      scope_kind: body.scope_kind as SkillInstallScope,
      opaque_scope_id: body.opaque_scope_id,
      client: body.client as SkillClient,
      digest: body.digest.toLowerCase(),
      policy: body.policy as SkillInstallPolicy,
      installed_by: actor?.id ?? null,
      updated_at: now,
      removed_at: body.removed ? now : null,
    })
    return c.json({ installation })
  })

  app.post("/v1/artifacts/:shortId/skills", async (c) => {
    const artifact = await requireArtifact(c, "publish", { split: true })
    if (artifact instanceof Response) return artifact
    const body = await readJson(c, artifactLinkBody)
    if (body instanceof Response) return body
    const skill = await requireArtifact(c, "read", { shortId: body.skill_short_id })
    if (skill instanceof Response) return skill
    if (skill.org_id !== artifact.org_id) return fail(c, 400, "skill must be in the same workspace")
    const [artifactVersion, definition] = await Promise.all([
      meta.getVersion(artifact.id, body.artifact_version),
      skillDefinition(skill.id, body.skill_version),
    ])
    if (!artifactVersion) return fail(c, 400, "artifact version not found")
    if (!definition) return fail(c, 400, "skill version not found")
    const actor = (await actingHuman(c)) ?? (await actingUser(c))
    const link = await meta.linkArtifactSkill({
      id: newId("asl"),
      org_id: artifact.org_id,
      artifact_id: artifact.id,
      artifact_version: body.artifact_version,
      skill_artifact_id: skill.id,
      skill_version: body.skill_version,
      role: body.role as ArtifactSkillRole,
      linked_by: actor?.id ?? "system",
    })
    return c.json({ link }, 201)
  })

  app.post("/v1/skill-migrations", async (c) => {
    const orgId = await requireWorkspace(c, "manage")
    if (orgId instanceof Response) return orgId
    const body = await readJson(c, z.object({ apply: z.boolean().default(false) }))
    if (body instanceof Response) return body
    const human = await actingHuman(c)
    if (!human) return fail(c, 403, "a signed-in workspace manager must run migrations")
    const actor = (await actingUser(c)) ?? human
    const report: Array<{
      kind: "context" | "workflow"
      id: string
      action: "migrate" | "skip"
      reason?: string
      skill_short_id?: string
    }> = []

    // Context definitions can change bundle entry type without changing artifact identity:
    // append SKILL.md + the private catalog sidecar to the same bundle.
    const contexts = await meta.listContexts(orgId)
    const manifests = new Map<string, (typeof contexts)[number]>()
    for (const context of contexts) manifests.set(context.manifest_artifact_id, context)
    for (const [artifactId, context] of manifests) {
      const artifact = (
        await meta.listArtifacts({ ids: [artifactId], orgId, archived: "include" })
      )[0]
      if (!artifact || artifact.current_content_type === SKILL_CONTENT_TYPE) {
        report.push({ kind: "context", id: context.id, action: "skip", reason: "already a Skill" })
        continue
      }
      if (!(await authorize(c, "publish", artifact))) {
        report.push({
          kind: "context",
          id: context.id,
          action: "skip",
          reason: "no publish access to definition",
        })
        continue
      }
      const version = await meta.getVersion(artifact.id, artifact.current_version)
      const manifest = version ? await manifestOf(blobs, version) : null
      const text = version ? await pageTextResolver(blobs, version) : null
      const manifestMd = manifest && text ? await text("/MANIFEST.md") : null
      if (!version || !manifest || !manifestMd) {
        report.push({
          kind: "context",
          id: context.id,
          action: "skip",
          reason: "no bundle MANIFEST.md",
        })
        continue
      }
      report.push({ kind: "context", id: context.id, action: "migrate" })
      if (!body.apply) continue
      const parsed = parseFrontmatter(manifestMd)
      const name = skillName(context.name, artifact.short_id)
      const description =
        parsed.attrs.description?.trim() || `Run the ${context.name} Derive Context.`
      const bytes = await mergeBundleZip(blobs, manifest, {
        "SKILL.md": `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${parsed.body.trim()}\n`,
        "derive.skill.json": JSON.stringify(
          { schema: "derive.skill/v1", catalog: false, runtime: { kind: "single" } },
          null,
          2,
        ),
      })
      const published = await publish(
        meta,
        blobs,
        {
          bytes,
          filename: "skill.zip",
          isBundle: true,
          title: artifact.title ?? context.name,
          message: "Auto-migrate Context manifest to Skill definition",
          author: human.name,
          authorId: human.id,
          agentId: actor.id === human.id ? null : actor.id,
          agentName: actor.id === human.id ? null : actor.name,
          source: "api",
          existingArtifact: artifact,
        },
        artifact.short_id,
      )
      await afterPublish(
        {
          meta,
          blobs,
          bus,
          notify,
          notifyRender,
          background,
          search,
          summarize,
          baseUrl: deps.baseUrl,
        },
        published.artifact,
        published.version,
        { isNew: false, onBehalf: human.id, actorId: actor.id, actorName: actor.name },
      )
    }

    // A Workflow is a visual artifact and cannot become a bundle in place. Create a private
    // launcher Skill, pin its exact runtime graph, link the original version, then give it a
    // root Context. A pre-existing link is the idempotency receipt for retries.
    const workflowCandidates = await meta.listFactAcrossArtifacts(orgId, WORKFLOW_DEFINITION_FACT, {
      limit: 100,
    })
    const allowedWorkflowIds = await visibleArtifactIds(
      meta,
      workflowCandidates.map((row) => row.id),
      { orgId, viewerId: human.id },
    )
    const workflowRows = workflowCandidates.filter((row) => allowedWorkflowIds.has(row.id))
    const workflowFacts = await meta.currentVersionDataForArtifacts(
      workflowRows.map((row) => row.id),
      [LINKED_BUNDLE_FACT],
    )
    const factsByArtifact = new Map<string, { slot: string; json: string }[]>(
      workflowRows.map((row) => [row.id, [{ slot: WORKFLOW_DEFINITION_FACT, json: row.json }]]),
    )
    for (const fact of workflowFacts) factsByArtifact.get(fact.artifact_id)?.push(fact)
    for (const row of workflowRows) {
      const existing = (await meta.listArtifactSkillLinks(row.id, row.n, orgId)).find(
        (link) => link.role === "workflow-definition",
      )
      if (existing) {
        const linkedSkill = (
          await meta.listArtifacts({
            ids: [existing.skill_artifact_id],
            orgId,
            archived: "include",
          })
        )[0]
        // The exact provenance link is the durable migration receipt, but the root
        // Context is a separate write. Repair that second half on replay if a prior
        // attempt stopped between the two writes.
        if (
          body.apply &&
          linkedSkill &&
          !contexts.some((context) => context.manifest_artifact_id === linkedSkill.id)
        ) {
          try {
            const created = await createContextCore(meta, {
              orgId,
              userId: human.id,
              name: `${row.title ?? "Workflow"} Launcher · ${row.short_id}`,
              manifestArtifactId: linkedSkill.id,
            })
            contexts.push(created.context)
          } catch (error) {
            if (!(error instanceof ContextConflictError)) throw error
          }
        }
        report.push({
          kind: "workflow",
          id: row.short_id,
          action: "skip",
          reason: "already linked",
          ...(linkedSkill ? { skill_short_id: linkedSkill.short_id } : {}),
        })
        continue
      }
      const parsed = parseLinkedWorkflowFacts(factsByArtifact.get(row.id) ?? [])
      if (!parsed.definition) {
        report.push({
          kind: "workflow",
          id: row.short_id,
          action: "skip",
          reason: "invalid definition",
        })
        continue
      }
      report.push({ kind: "workflow", id: row.short_id, action: "migrate" })
      if (!body.apply) continue
      const runtimeKind = parsed.definition.diagrams.some(
        (diagram) => (diagram.loops?.length ?? 0) > 0,
      )
        ? "loop"
        : "graph"
      const name = skillName(`${row.title ?? "workflow"}-${row.short_id}`, row.short_id)
      const skillMd = `---\nname: ${name}\ndescription: ${JSON.stringify(`Run the ${row.title ?? "workflow"} workflow through Derive.`)}\n---\n\nUse the Derive integration to run workflow artifact \`${row.short_id}\`. The graph, human gates, retries, and loop bounds remain authoritative in Derive.\n`
      const bytes = await zipBundleFiles({
        "SKILL.md": skillMd,
        "derive.skill.json": JSON.stringify(
          {
            schema: "derive.skill/v1",
            catalog: false,
            runtime: { kind: runtimeKind, definition: parsed.definition },
          },
          null,
          2,
        ),
      })
      const sourceArtifact = (
        await meta.listArtifacts({ ids: [row.id], orgId, archived: "include" })
      )[0]
      if (!sourceArtifact) continue
      // The deterministic id is the recovery receipt for the one unavoidable gap
      // between creating the launcher artifact and writing its provenance link. A
      // replay reuses that exact derived Skill instead of publishing a duplicate.
      const launcherShortId = workflowSkillShortId(row.short_id)
      const recoverable = await meta.getByShortId(launcherShortId)
      if (
        recoverable &&
        (recoverable.org_id !== orgId ||
          recoverable.derived_from !== sourceArtifact.id ||
          recoverable.current_content_type !== SKILL_CONTENT_TYPE)
      ) {
        const reportRow = report.at(-1)
        if (reportRow) Object.assign(reportRow, { action: "skip", reason: "launcher id collision" })
        continue
      }
      let launcherArtifact = recoverable
      let launcherVersion = recoverable
        ? await meta.getVersion(recoverable.id, recoverable.current_version)
        : null
      if (!launcherArtifact || !launcherVersion) {
        const published = await publish(meta, blobs, {
          bytes,
          filename: "skill.zip",
          isBundle: true,
          title: `${row.title ?? "Workflow"} Skill`,
          message: `Auto-migrate workflow ${row.short_id} to a launcher Skill`,
          author: human.name,
          authorId: human.id,
          agentId: actor.id === human.id ? null : actor.id,
          agentName: actor.id === human.id ? null : actor.name,
          source: "api",
          orgId,
          workspaceAccess: sourceArtifact.workspace_access,
          linkRole: "none",
          listed: "none",
          derivedFrom: sourceArtifact.id,
          mintShortId: launcherShortId,
        })
        launcherArtifact = published.artifact
        launcherVersion = published.version
      }
      await afterPublish(
        {
          meta,
          blobs,
          bus,
          notify,
          notifyRender,
          background,
          search,
          summarize,
          baseUrl: deps.baseUrl,
        },
        launcherArtifact,
        launcherVersion,
        { isNew: !recoverable, onBehalf: human.id, actorId: actor.id, actorName: actor.name },
      )
      await meta.linkArtifactSkill({
        id: newId("asl"),
        org_id: orgId,
        artifact_id: row.id,
        artifact_version: row.n,
        skill_artifact_id: launcherArtifact.id,
        skill_version: launcherVersion.n,
        role: "workflow-definition",
        linked_by: human.id,
      })
      try {
        await createContextCore(meta, {
          orgId,
          userId: human.id,
          name: `${row.title ?? "Workflow"} Launcher · ${row.short_id}`,
          manifestArtifactId: launcherArtifact.id,
        })
      } catch (error) {
        if (!(error instanceof ContextConflictError)) throw error
      }
      const reportRow = report.at(-1)
      if (reportRow) reportRow.skill_short_id = launcherArtifact.short_id
    }

    return c.json({ applied: body.apply, report })
  })

  return app
}

const skillName = (value: string, fallback: string): string => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "")
  return (
    normalized ||
    fallback
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 64)
  )
}

const workflowSkillShortId = (sourceShortId: string): string => `skill-${sourceShortId}`

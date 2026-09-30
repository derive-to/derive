import {
  type ArtifactSkillRole,
  newId,
  publish,
  SKILL_CONTENT_TYPE,
  SKILL_SIDECAR_PATH,
  type SkillClient,
  type SkillInstallPolicy,
  type SkillInstallScope,
  type SkillUseClient,
  toJson,
  validateSkillDefinition,
} from "@derive/core"
import { OpenAPIHono } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import { z } from "zod"
import type { AppContext } from "../context"
import { afterPublish, indexSkillVersion } from "../lib/after-publish"
import { manifestOf, mergeBundleZip, pageTextResolver } from "../lib/bundle"
import { fail, readJson } from "../lib/http"
import { log } from "../log"

const installationBody = z.object({
  skill_version: z.number().int().positive(),
  scope_kind: z.enum(["project", "personal", "runner"]),
  opaque_scope_id: z.string().min(16).max(128),
  client: z.enum(["claude", "codex"]),
  digest: z.string().regex(/^[a-f0-9]{64}$/i),
  policy: z.enum(["pinned", "latest"]),
  removed: z.boolean().optional(),
})

const localUseBody = z.object({
  event_id: z.string().min(8).max(128),
  skill_version: z.number().int().positive(),
  client: z.enum(["claude", "codex", "other"]),
  stage: z.enum(["selected", "loaded", "acted", "completed"]).optional(),
  evidence: z.enum(["native_hook", "structured_log", "skill_file_read", "claimed"]).optional(),
  skill_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
  opaque_session_id: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
  occurred_at: z.string().datetime().optional(),
  useful: z.boolean().optional(),
})

const scannedUseBody = localUseBody.extend({ skill_short_id: z.string().min(1).max(128) })
const scanCoverageBody = z.object({
  client: z.enum(["claude", "codex"]),
  source_files: z.number().int().nonnegative(),
  sessions_scanned: z.number().int().nonnegative(),
  records_scanned: z.number().int().nonnegative(),
  parser_version: z.number().int().positive(),
  scanned_at: z.string().datetime(),
})
const scanBatchBody = z.object({
  uses: z.array(scannedUseBody).max(500),
  coverage: z.array(scanCoverageBody).max(10),
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

const skillSourceBody = z.object({
  source: z.string().max(1_000_000),
  base_version: z.number().int().positive(),
  message: z.string().max(500).optional(),
  title: z.string().trim().min(1).max(200).optional(),
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
            workflow_launcher: definition.sidecar?.origin?.kind === "workflow-launcher",
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

  // The authored heart of a Skill is ordinary Markdown. Expose it directly so the
  // existing browser source editor can edit SKILL.md without making the person
  // download, unzip, rebuild, and re-upload the whole bundle. The write overlays
  // only that file; scripts, references, assets, and derive.skill.json are retained.
  app.get("/v1/artifacts/:shortId/skill-source", async (c) => {
    const skill = await requireArtifact(c, "read")
    if (skill instanceof Response) return skill
    if (skill.current_content_type !== SKILL_CONTENT_TYPE) return fail(c, 404, "not a skill")
    const version = await meta.getVersion(skill.id, skill.current_version)
    const text = version ? await pageTextResolver(blobs, version) : null
    const source = text ? await text("/SKILL.md") : null
    if (!version || source === null) return fail(c, 404, "SKILL.md not found")
    return c.json({ source, version: version.n })
  })

  app.put("/v1/artifacts/:shortId/skill-source", async (c) => {
    const skill = await requireArtifact(c, "publish", { split: true })
    if (skill instanceof Response) return skill
    if (skill.current_content_type !== SKILL_CONTENT_TYPE) return fail(c, 404, "not a skill")
    if (skill.locked) return fail(c, 409, "artifact is locked — unlock it to publish")
    const body = await readJson(c, skillSourceBody)
    if (body instanceof Response) return body
    if (body.base_version !== skill.current_version)
      return fail(c, 409, `Skill changed since editing began (now v${skill.current_version})`)

    const version = await meta.getVersion(skill.id, skill.current_version)
    const manifest = version ? await manifestOf(blobs, version) : null
    const text = version ? await pageTextResolver(blobs, version) : null
    const sidecar = text ? await text(SKILL_SIDECAR_PATH) : null
    if (!version || !manifest || sidecar === null) return fail(c, 404, "Skill bundle not found")
    const checked = validateSkillDefinition(body.source, sidecar)
    if (checked.errors.length) return fail(c, 400, checked.errors.join("; "))

    const human = await actingHuman(c)
    const actor = (await actingUser(c)) ?? human
    const bytes = await mergeBundleZip(blobs, manifest, { "SKILL.md": body.source })
    const saved = await publish(
      meta,
      blobs,
      {
        bytes,
        filename: "skill.zip",
        isBundle: true,
        title: body.title ?? skill.title ?? checked.metadata?.name ?? undefined,
        message: body.message?.trim() || "Edited SKILL.md in browser",
        author: human?.name ?? actor?.name ?? undefined,
        authorId: human?.id ?? null,
        agentId: actor && actor.id !== human?.id ? actor.id : null,
        agentName: actor && actor.id !== human?.id ? actor.name : null,
        source: "web",
        existingArtifact: skill,
      },
      skill.short_id,
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
      saved.artifact,
      saved.version,
      {
        isNew: false,
        onBehalf: human?.id ?? null,
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? null,
      },
    )
    return c.json(toJson(deps.baseUrl, saved.artifact, await meta.listVersions(saved.artifact.id)))
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
    const [usage, local, installations, links, coverageRows] = await Promise.all([
      meta.skillUsage(skill.id, skill.org_id),
      meta.skillLocalUsage(skill.id, skill.org_id),
      meta.listSkillInstallations(skill.id, skill.org_id),
      meta.listSkillArtifactLinks(skill.id, skill.org_id, 100),
      meta.listSkillScanCoverage(skill.org_id),
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
    const coverage = new Map<
      SkillUseClient,
      {
        client: SkillUseClient
        contributors: number
        source_files: number
        sessions_scanned: number
        records_scanned: number
        parser_version: number
        last_scanned_at: string
      }
    >()
    for (const row of coverageRows) {
      const current = coverage.get(row.client)
      coverage.set(row.client, {
        client: row.client,
        contributors: (current?.contributors ?? 0) + 1,
        source_files: (current?.source_files ?? 0) + row.source_files,
        sessions_scanned: (current?.sessions_scanned ?? 0) + row.sessions_scanned,
        records_scanned: (current?.records_scanned ?? 0) + row.records_scanned,
        parser_version: Math.max(current?.parser_version ?? 0, row.parser_version),
        last_scanned_at:
          !current || row.scanned_at > current.last_scanned_at
            ? row.scanned_at
            : current.last_scanned_at,
      })
    }
    return c.json({
      contexts: usage.contexts,
      workflows: usage.workflows,
      local,
      installations: [...installSummary.values()],
      coverage: [...coverage.values()],
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

  app.post("/v1/artifacts/:shortId/skill-usage", async (c) => {
    const skill = await requireArtifact(c, "read")
    if (skill instanceof Response) return skill
    if (skill.current_content_type !== SKILL_CONTENT_TYPE) return fail(c, 404, "not a skill")
    const body = await readJson(c, localUseBody)
    if (body instanceof Response) return body
    if (!(await skillDefinition(skill.id, body.skill_version)))
      return fail(c, 400, "skill version not found")
    const actor = (await actingHuman(c)) ?? (await actingUser(c))
    if (!actor) return fail(c, 401, "a signed-in user or user-authorized agent is required")
    const now = new Date().toISOString()
    const use = await meta.recordSkillUse({
      id: newId("sku"),
      event_id: body.event_id,
      org_id: skill.org_id,
      skill_artifact_id: skill.id,
      skill_version: body.skill_version,
      used_by: actor.id,
      client: body.client,
      stage: body.stage ?? "completed",
      evidence: body.evidence ?? "claimed",
      ...(body.skill_digest ? { skill_digest: body.skill_digest } : {}),
      ...(body.opaque_session_id ? { opaque_session_id: body.opaque_session_id } : {}),
      ...(body.useful !== undefined ? { useful: body.useful ? 1 : 0 } : {}),
      occurred_at: body.occurred_at ?? now,
      updated_at: now,
    })
    return c.json({ use })
  })

  app.post("/v1/skill-usage/batch", async (c) => {
    const body = await readJson(c, scanBatchBody)
    if (body instanceof Response) return body
    const actor = (await actingHuman(c)) ?? (await actingUser(c))
    if (!actor) return fail(c, 401, "a signed-in user or user-authorized agent is required")
    const orgId = await activeWorkspace(c)
    const definitions = []
    for (const item of body.uses) {
      const skill = await requireArtifact(c, "read", { shortId: item.skill_short_id })
      if (skill instanceof Response) return skill
      if (skill.org_id !== orgId || skill.current_content_type !== SKILL_CONTENT_TYPE)
        return fail(c, 404, `not a skill: ${item.skill_short_id}`)
      if (!(await skillDefinition(skill.id, item.skill_version)))
        return fail(c, 400, `skill version not found: ${item.skill_short_id}`)
      definitions.push({ item, skill })
    }
    const now = new Date().toISOString()
    for (const { item, skill } of definitions)
      await meta.recordSkillUse({
        id: newId("sku"),
        event_id: item.event_id,
        org_id: orgId,
        skill_artifact_id: skill.id,
        skill_version: item.skill_version,
        used_by: actor.id,
        client: item.client,
        stage: item.stage ?? "loaded",
        evidence: item.evidence ?? "structured_log",
        ...(item.skill_digest ? { skill_digest: item.skill_digest } : {}),
        ...(item.opaque_session_id ? { opaque_session_id: item.opaque_session_id } : {}),
        ...(item.useful !== undefined ? { useful: item.useful ? 1 : 0 } : {}),
        occurred_at: item.occurred_at ?? now,
        updated_at: now,
      })
    for (const row of body.coverage)
      await meta.upsertSkillScanCoverage({
        id: newId("skc"),
        org_id: orgId,
        scanned_by: actor.id,
        client: row.client,
        source_files: row.source_files,
        sessions_scanned: row.sessions_scanned,
        records_scanned: row.records_scanned,
        parser_version: row.parser_version,
        scanned_at: row.scanned_at,
        updated_at: now,
      })
    return c.json({ recorded: definitions.length, coverage: body.coverage.length })
  })

  app.get("/v1/artifacts/:shortId/skills", async (c) => {
    const artifact = await requireArtifact(c, "read")
    if (artifact instanceof Response) return artifact
    const links = await meta.listArtifactSkillLinkHistory(artifact.id, artifact.org_id)
    const skills = await meta.listArtifacts({
      ids: [...new Set(links.map((link) => link.skill_artifact_id))],
      orgId: artifact.org_id,
      archived: "include",
    })
    const readable = new Map<string, (typeof skills)[number]>()
    for (const skill of skills) {
      if (skill.current_content_type !== SKILL_CONTENT_TYPE) continue
      if (await authorize(c, "read", skill)) readable.set(skill.id, skill)
    }
    return c.json({
      links: links
        .filter((link) => readable.has(link.skill_artifact_id))
        .map((link) => {
          const skill = readable.get(link.skill_artifact_id)
          return {
            ...link,
            skill: skill
              ? {
                  short_id: skill.short_id,
                  title: skill.title,
                  current_version: skill.current_version,
                }
              : null,
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
    // Contexts and workflow launchers no longer migrate into Skills (the agents cutover
    // retired both); what remains is the Skill relation backfill.
    const report: never[] = []

    // Rebuild current Skill relation indexes so this migration also backfills references
    // inferred from Skills published before inference existed. This is idempotent and does not
    // create a new artifact version: the index remains a cache over immutable version bytes.
    if (body.apply) {
      let cursor: { key: string; id: string } | undefined
      for (;;) {
        const skills = await meta.listArtifacts({
          orgId,
          contentType: SKILL_CONTENT_TYPE,
          archived: "include",
          limit: 100,
          cursor,
        })
        for (const skill of skills) {
          const version = await meta.getVersion(skill.id, skill.current_version)
          if (!version) continue
          try {
            await indexSkillVersion(meta, blobs, skill, version)
          } catch (error) {
            // One damaged historical bundle must not prevent every healthy Skill from being
            // backfilled. The same best-effort boundary is used by the live publish indexer.
            log.warn("skill relation backfill failed", {
              artifact: skill.id,
              n: version.n,
              error: String(error),
            })
          }
        }
        const last = skills.at(-1)
        if (skills.length < 100 || !last) break
        cursor = { key: last.created_at, id: last.id }
      }
    }

    return c.json({ applied: body.apply, report })
  })

  return app
}

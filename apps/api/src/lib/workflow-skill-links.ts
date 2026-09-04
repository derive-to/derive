import {
  type ArtifactRecord,
  type BlobStore,
  type MetaStore,
  newId,
  SKILL_CONTENT_TYPE,
  type VersionRecord,
} from "@derive/core"
import { pageTextResolver } from "./bundle"
import { parseManifestSkillPins } from "./manifest-pins"
import { parseLinkedWorkflowFacts } from "./workflow-facts"

type FactRow = { slot: string; json: string }

/**
 * Index the Skills a Workflow can actually materialize through its Context nodes.
 *
 * The workflow fact owns topology; each Context definition owns its exact Skill pins.
 * This joins those two existing sources of truth into the bidirectional artifact ↔ Skill
 * index used by the web UI. It deliberately does not infer Skill names from prose.
 */
export const indexWorkflowSkillLinks = async (
  meta: MetaStore,
  blobs: BlobStore,
  artifact: ArtifactRecord,
  version: VersionRecord,
  facts: FactRow[],
): Promise<void> => {
  const definition = parseLinkedWorkflowFacts(facts).definition
  if (!definition) return

  const contextRefs = new Set(
    definition.diagrams.flatMap((diagram) =>
      diagram.nodes
        .filter((node) => node.kind === "context" && node.context_ref)
        .map((node) => node.context_ref as string),
    ),
  )
  if (!contextRefs.size) return
  const contexts = (await meta.listContexts(artifact.org_id)).filter(
    (context) => contextRefs.has(context.id) || contextRefs.has(context.name),
  )
  const pins = new Map<string, number>()
  for (const context of contexts) {
    const manifestArtifact = await meta.getArtifactById(context.manifest_artifact_id)
    if (!manifestArtifact || manifestArtifact.org_id !== artifact.org_id) continue
    const manifestVersion = await meta.getVersion(
      manifestArtifact.id,
      manifestArtifact.current_version,
    )
    if (!manifestVersion) continue
    const source = await pageTextResolver(blobs, manifestVersion)
    const markdown = await source(null)
    if (!markdown) continue
    for (const pin of parseManifestSkillPins(markdown)) {
      const skill = await meta.getByShortId(pin.id)
      if (!skill || skill.org_id !== artifact.org_id) continue
      const skillVersion = pin.version ?? skill.current_version
      const exact = await meta.getVersion(skill.id, skillVersion)
      if (exact?.content_type !== SKILL_CONTENT_TYPE) continue
      pins.set(skill.id, skillVersion)
    }
  }

  for (const [skillArtifactId, skillVersion] of pins) {
    await meta.linkArtifactSkill({
      id: newId("asl"),
      org_id: artifact.org_id,
      artifact_id: artifact.id,
      artifact_version: version.n,
      skill_artifact_id: skillArtifactId,
      skill_version: skillVersion,
      role: "workflow-definition",
      linked_by: version.author_id ?? version.agent_id ?? "system",
    })
  }
}

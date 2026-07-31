// Everything an unfurl or embed surface needs about one artifact, plus the absolute URLs of the
// sibling endpoints.
//
// Extracted out of routes/embeds.ts so the Slack link-unfurl builder (lib/slack-unfurl.ts)
// renders from the SAME source as the OG card, the oEmbed document and the injected meta tags.
// Three surfaces describing one artifact should not each describe it their own way — and the
// Slack card in particular reuses `imageUrl`, which already degrades to a title-less locked card
// for a viewer who can't read the artifact (see the /v1/og handler).

import {
  type ArtifactRecord,
  artifactUrl,
  factSummary,
  kindLabel,
  type MetaStore,
  type UnfurlInfo,
} from "@derive/core"

export const unfurlInfoFor = async (
  meta: MetaStore,
  baseUrl: string,
  artifact: ArtifactRecord,
): Promise<UnfurlInfo> => {
  // One round trip. The counts used to come from `listVersions(...).length` and
  // `listComments(...).length` — two whole-table reads to produce two integers, on the
  // most-trafficked anonymous surface there is — plus a trip each for the version row
  // and the facts. The Promise.all around them bought nothing: one pg.Client per
  // request means node-postgres queues them (see edge-pg.ts). The facts ride in the same
  // query now, so they no longer need their own best-effort catch: there is no longer a
  // fact read that can fail independently of the counts this card is built from.
  const { versionCount, commentCount, version, facts } = await meta.unfurlInfo(
    artifact.id,
    artifact.current_version,
  )
  const ref = artifactUrl(baseUrl, artifact).slice(`${baseUrl}/artifacts/`.length)
  return {
    title: artifact.title ?? "Untitled",
    kindLabel: kindLabel(version?.content_type, artifact.kind === "bundle"),
    versionCount,
    commentCount,
    // The reward for publishing a fact: the shared link carries its own numbers.
    dataSummary: factSummary(facts),
    pageUrl: artifactUrl(baseUrl, artifact),
    imageUrl: `${baseUrl}/v1/og/${artifact.short_id}`,
    oembedUrl: `${baseUrl}/v1/oembed?url=${encodeURIComponent(artifactUrl(baseUrl, artifact))}`,
    embedUrl: `${baseUrl}/v1/embed/${ref}`,
  }
}

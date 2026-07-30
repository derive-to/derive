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
  kindLabel,
  type MetaStore,
  type UnfurlInfo,
} from "@derive/core"

export const unfurlInfoFor = async (
  meta: MetaStore,
  baseUrl: string,
  artifact: ArtifactRecord,
): Promise<UnfurlInfo> => {
  const [versions, comments, version] = await Promise.all([
    meta.listVersions(artifact.id),
    meta.listComments(artifact.id),
    meta.getVersion(artifact.id, artifact.current_version),
  ])
  const ref = artifactUrl(baseUrl, artifact).slice(`${baseUrl}/artifacts/`.length)
  return {
    title: artifact.title ?? "Untitled",
    kindLabel: kindLabel(version?.content_type, artifact.kind === "bundle"),
    versionCount: versions.length,
    commentCount: comments.length,
    pageUrl: artifactUrl(baseUrl, artifact),
    imageUrl: `${baseUrl}/v1/og/${artifact.short_id}`,
    oembedUrl: `${baseUrl}/v1/oembed?url=${encodeURIComponent(artifactUrl(baseUrl, artifact))}`,
    embedUrl: `${baseUrl}/v1/embed/${ref}`,
  }
}

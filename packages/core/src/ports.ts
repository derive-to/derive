/**
 * Core owns the ports; packages/db and packages/storage provide the adapters.
 * Everything here must run on Node AND Cloudflare Workers — no Node APIs.
 */

export interface BlobStore {
  /** Content-addressed put; returns the sha256 hex key. Idempotent. */
  put(data: Uint8Array): Promise<string>
  get(key: string): Promise<Uint8Array | null>
}

export type ArtifactKind = "file" | "bundle"
export type Visibility = "public" | "link" | "org" | "password"

export interface ArtifactRecord {
  id: string
  short_id: string
  org_id: string
  slug: string | null
  title: string | null
  visibility: Visibility
  kind: ArtifactKind
  spa: 0 | 1
  current_version: number
  created_at: string
}

export interface VersionRecord {
  id: string
  artifact_id: string
  n: number
  blob_key: string
  content_type: string
  author: string
  message: string | null
  created_at: string
}

export interface NewArtifact {
  id: string
  short_id: string
  org_id: string
  slug: string | null
  title: string | null
  visibility: Visibility
  kind: ArtifactKind
  spa: 0 | 1
}

export interface NewVersion {
  id: string
  blob_key: string
  content_type: string
  author: string
  message: string | null
}

export interface MetaStore {
  createArtifact(a: NewArtifact): Promise<ArtifactRecord>
  getByShortId(shortId: string): Promise<ArtifactRecord | null>
  /** Appends the next version and bumps current_version. */
  addVersion(artifactId: string, v: NewVersion): Promise<VersionRecord>
  listVersions(artifactId: string): Promise<VersionRecord[]>
  getVersion(artifactId: string, n: number): Promise<VersionRecord | null>
}

/** A bundle version's blob is this manifest; file versions point at content directly. */
export interface BundleManifest {
  entry: string
  spa: boolean
  files: Record<string, { key: string; type: string }>
}

export const BUNDLE_CONTENT_TYPE = "dock/bundle"

export { R2BlobStore, type R2Like } from "./r2"
// FsBlobStore is exported from "@dock/storage/fs" only — it uses node:fs and
// must never be imported by an edge entrypoint.

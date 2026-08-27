import { artifactUrl, type ExportJobRecord } from "@derive/core"
import {
  buildExportEmail,
  buildQaEmailCapture,
  csvFromJson,
  type ExportOptions,
  imageBackedPptx,
} from "./lib/export-system"
import { imageDimensions } from "./lib/image"
import { signPreviewToken } from "./lib/preview-token"
import type { RenderTickDeps } from "./lib/renderer"
import { log } from "./log"
import { enqueueCoalescedChannelDelivery } from "./webhooks"

export const EXPORT_CLAIM_LIMIT = 2
const MAX_EXPORT_BYTES = 25 * 1024 * 1024
const RETRY_BASE_MS = 5_000
const CLAIM_LEASE_MS = 120_000
const MAX_ATTEMPTS = 4
const RENDER_TIMEOUT_MS = 20_000

const backoff = (attempts: number): number => Math.min(30 * 60_000, RETRY_BASE_MS * 2 ** attempts)
const optionsOf = (job: ExportJobRecord): ExportOptions => {
  try {
    return JSON.parse(job.options_json) as ExportOptions
  } catch {
    return {}
  }
}

const output = async (
  deps: RenderTickDeps,
  job: ExportJobRecord,
  bytes: Uint8Array,
  type: string,
  publicAsset = false,
): Promise<string> => {
  const live = await deps.meta.getExportJob(job.id)
  if (live?.status === "cancelled") return ""
  if (bytes.byteLength > MAX_EXPORT_BYTES) throw new Error("export exceeds the 25MB output limit")
  const key = await deps.blobs.put(bytes)
  if (publicAsset) {
    const size = type === "image/png" ? imageDimensions(bytes) : null
    await deps.meta.createAsset({
      hash: key,
      org_id: job.org_id,
      content_type: type,
      size_bytes: bytes.byteLength,
      width: size?.width ?? null,
      height: size?.height ?? null,
    })
  }
  await deps.meta.updateExportJob(job.id, {
    status: "ready",
    attempts: job.attempts,
    last_error: null,
    error_class: null,
    output_key: key,
    output_type: type,
    output_bytes: bytes.byteLength,
    public_asset_hash: publicAsset ? key : null,
    updated_at: new Date().toISOString(),
  })
  return key
}

const renderUrl = async (deps: RenderTickDeps, job: ExportJobRecord, shortId: string) => {
  const pv = await signPreviewToken(
    deps.secret,
    job.artifact_id,
    job.version_n,
    Date.now() + CLAIM_LEASE_MS,
  )
  const origin = deps.sandboxOrigin ?? deps.baseUrl
  return `${origin}/raw/${shortId}/v/${job.version_n}/pv/${pv}/index.html?derive-render=${encodeURIComponent(job.profile)}`
}

const chartPng = async (
  deps: RenderTickDeps,
  url: string,
  options: ExportOptions,
): Promise<Uint8Array> => {
  const selector = options.region ?? "[data-derive-export-region]"
  try {
    return await deps.renderer.screenshot(url, {
      width: 1200,
      height: 630,
      deviceScaleFactor: 2,
      timeoutMs: RENDER_TIMEOUT_MS,
      selector,
      exportMode: true,
    })
  } catch (error) {
    if (options.region) throw error
    return deps.renderer.screenshot(url, {
      width: 1200,
      height: 630,
      deviceScaleFactor: 2,
      timeoutMs: RENDER_TIMEOUT_MS,
      exportMode: true,
    })
  }
}

const processJob = async (deps: RenderTickDeps, job: ExportJobRecord): Promise<void> => {
  const artifact = await deps.meta.getArtifactById(job.artifact_id)
  const version = await deps.meta.getVersion(job.artifact_id, job.version_n)
  if (!artifact || artifact.removed_at || !version)
    throw new Error("pinned artifact version is unavailable")
  const options = optionsOf(job)
  if (job.expires_at && Date.parse(job.expires_at) <= Date.now()) {
    await deps.meta.updateExportJob(job.id, {
      status: "expired",
      updated_at: new Date().toISOString(),
    })
    return
  }

  if (job.kind === "chart_json" || job.kind === "chart_csv") {
    if (!options.dataSlot) throw new Error("declared dataSlot is required")
    const row = (await deps.meta.getVersionData(artifact.id, job.version_n, options.dataSlot))[0]
    if (!row) throw new Error(`declared data slot not found: ${options.dataSlot}`)
    const value = JSON.parse(row.json) as unknown
    const body =
      job.kind === "chart_json"
        ? JSON.stringify(
            {
              derive: { artifact: artifact.short_id, version: job.version_n, slot: row.slot },
              data: value,
            },
            null,
            2,
          )
        : csvFromJson(value)
    await output(
      deps,
      job,
      new TextEncoder().encode(body),
      job.kind === "chart_json" ? "application/json" : "text/csv",
    )
    return
  }

  const url = await renderUrl(deps, job, artifact.short_id)
  if (job.kind === "page_pdf" || job.kind === "deck_pdf") {
    if (!deps.renderer.pdf) throw new Error("PDF rendering is not supported by this renderer")
    const pdf = await deps.renderer.pdf(url, {
      timeoutMs: RENDER_TIMEOUT_MS,
      deck: job.kind === "deck_pdf",
    })
    await output(deps, job, pdf, "application/pdf")
    return
  }
  if (job.kind === "deck_pptx") {
    if (!deps.renderer.deckImages)
      throw new Error("deck rendering is not supported by this renderer")
    const slides = await deps.renderer.deckImages(url, RENDER_TIMEOUT_MS)
    const pptx = imageBackedPptx(
      slides,
      `${artifactUrl(deps.baseUrl, artifact)}/v/${job.version_n} · image-backed, not element-editable`,
    )
    await output(
      deps,
      job,
      pptx,
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    )
    return
  }

  const png = await chartPng(deps, url, options)
  if (job.kind === "chart_png") {
    await output(deps, job, png, "image/png", !!options.publicImage)
    return
  }

  if (!options.recipient) throw new Error("email recipient is required")
  const publicImage = !!options.publicImage
  const imageKey = await deps.blobs.put(png)
  let imageUrl = "cid:derive-export"
  if (publicImage) {
    const size = imageDimensions(png)
    await deps.meta.createAsset({
      hash: imageKey,
      org_id: artifact.org_id,
      content_type: "image/png",
      size_bytes: png.byteLength,
      width: size?.width ?? null,
      height: size?.height ?? null,
    })
    imageUrl = `${deps.baseUrl.replace(/\/$/, "")}/blob/${imageKey}.png`
  }
  const attachments: Array<{
    filename: string
    contentType: string
    blobKey: string
    contentId?: string
  }> = publicImage
    ? []
    : [
        {
          filename: "derive-export.png",
          contentType: "image/png",
          blobKey: imageKey,
          contentId: "derive-export",
        },
      ]
  let pdfLinked = false
  if (options.attachPdf) {
    if (!deps.renderer.pdf) throw new Error("PDF rendering is not supported by this renderer")
    const pdf = await deps.renderer.pdf(url, { timeoutMs: RENDER_TIMEOUT_MS })
    const pdfKey = await deps.blobs.put(pdf)
    if (pdf.byteLength <= 8 * 1024 * 1024)
      attachments.push({
        filename: "derive-export.pdf",
        contentType: "application/pdf",
        blobKey: pdfKey,
      })
    else pdfLinked = true
  }
  const msg = buildExportEmail({
    to: options.recipient,
    title: options.title ?? artifact.title ?? artifact.short_id,
    note: [
      options.note,
      pdfLinked
        ? "The PDF exceeded the safe email attachment limit; open the pinned artifact in Derive."
        : undefined,
    ]
      .filter((value): value is string => !!value)
      .join("\n\n"),
    openUrl: artifactUrl(deps.baseUrl, artifact),
    imageUrl,
    alt: options.title ?? artifact.title ?? "Static Derive artifact preview",
    version: job.version_n,
  })
  if ((await deps.meta.getExportJob(job.id))?.status === "cancelled") return
  if (options.qaCapture) {
    const capture = buildQaEmailCapture({
      message: msg,
      cidImage: publicImage ? undefined : png,
      attachments: attachments.map(({ filename, contentType }) => ({ filename, contentType })),
    })
    await output(deps, job, capture, "text/html")
    return
  }
  await enqueueCoalescedChannelDelivery(
    deps.meta,
    `wd_export_${job.id}`,
    "email",
    "artifact.export",
    {
      ...msg,
      attachments,
    },
  )
  await output(deps, job, png, "image/png", publicImage)
}

export const runExportTick = async (
  deps: RenderTickDeps,
  limit = EXPORT_CLAIM_LIMIT,
): Promise<number> => {
  const now = new Date()
  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString()
  const due = await deps.meta.claimDueExportJobs(
    now.toISOString(),
    limit,
    leaseUntil,
    deps.baseUrl.replace(/\/$/, ""),
  )
  for (const job of due) {
    try {
      await processJob(deps, job)
      log.info("export ready", {
        jobId: job.id,
        kind: job.kind,
        attempts: job.attempts,
        renderer: deps.sandboxOrigin ? "edge" : "node",
      })
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 200)
      const errorClass = error instanceof Error ? error.name : "Error"
      const terminal = job.attempts >= MAX_ATTEMPTS
      await deps.meta.updateExportJob(job.id, {
        status: terminal ? "dead" : "failed",
        attempts: job.attempts,
        last_error: message,
        error_class: errorClass,
        next_attempt_at: terminal
          ? job.next_attempt_at
          : new Date(Date.now() + backoff(job.attempts)).toISOString(),
        updated_at: new Date().toISOString(),
      })
      log.error("export failed", { jobId: job.id, kind: job.kind, error: message, terminal })
    }
  }
  return due.length
}

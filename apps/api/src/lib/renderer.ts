import type { BlobStore, MetaStore } from "@derive/core"

export interface ScreenshotOpts {
  width: number
  height: number
  fullPage?: boolean
  timeoutMs: number
  /** Device pixel density. Defaults to 1. */
  deviceScaleFactor?: number
  /** Optional declared export region. Preview calls leave this unset. */
  selector?: string
  /** Enables the bounded font/image/chart readiness contract and export-only CSS. */
  exportMode?: boolean
}

export interface PdfOpts {
  timeoutMs: number
  deck?: boolean
}

export interface Renderer {
  screenshot(url: string, opts: ScreenshotOpts): Promise<Uint8Array>
  pdf?(url: string, opts: PdfOpts): Promise<Uint8Array>
  deckImages?(url: string, timeoutMs: number): Promise<Uint8Array[]>
}

/** Shared worker dependencies for preview renders and user-requested exports. */
export interface RenderTickDeps {
  meta: MetaStore
  blobs: BlobStore
  renderer: Renderer
  baseUrl: string
  sandboxOrigin?: string
  secret: string
}

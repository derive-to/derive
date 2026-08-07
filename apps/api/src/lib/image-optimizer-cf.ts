import type { ImageOptimizer } from "./image-optimizer"
import { OPTIMIZED_IMAGE_MAX_EDGE, OPTIMIZED_IMAGE_QUALITY } from "./image-optimizer"

interface ImagesOutput {
  response(): Response
}

interface ImagesTransform {
  transform(options: {
    width: number
    height: number
    fit: "scale-down"
    metadata: "none"
  }): ImagesTransform
  output(options: { format: string; quality?: number; anim?: boolean }): Promise<ImagesOutput>
}

/** The structural slice of Cloudflare's Images binding used by Derive. */
export interface ImagesBindingLike {
  input(stream: ReadableStream): ImagesTransform
}

/** Cloudflare Workers image optimization, injected so the shared app stays edge-neutral. */
export const cloudflareImageOptimizer = (images: ImagesBindingLike): ImageOptimizer => {
  return async (bytes, type) => {
    // Copy to an owned ArrayBuffer: Uint8Array's generic buffer may be SharedArrayBuffer,
    // which neither DOM nor workerd accepts as a Blob part.
    const input = images.input(new Blob([new Uint8Array(bytes).buffer], { type }).stream())
    const output = await input
      .transform({
        width: OPTIMIZED_IMAGE_MAX_EDGE,
        height: OPTIMIZED_IMAGE_MAX_EDGE,
        fit: "scale-down",
        metadata: "none",
      })
      .output({
        format: type,
        ...(type === "image/jpeg" || type === "image/webp"
          ? { quality: OPTIMIZED_IMAGE_QUALITY }
          : {}),
        ...(type === "image/gif" || type === "image/webp" ? { anim: true } : {}),
      })
    const response = output.response()
    if (!response.ok) throw new Error(`Cloudflare Images returned ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }
}

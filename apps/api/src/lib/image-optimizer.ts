import type { ImageType } from "./image"

/** The largest useful hard-coded image dimension when an artifact does not provide srcset. */
export const OPTIMIZED_IMAGE_MAX_EDGE = 1920

/** A high-enough default for screenshots and photos without carrying near-original bytes. */
export const OPTIMIZED_IMAGE_QUALITY = 82

/** Hosted runtime adapter for image optimization through the Workers Images binding. */
export type ImageOptimizer = (bytes: Uint8Array, type: ImageType) => Promise<Uint8Array>

import { describe, expect, it, vi } from "vitest"
import { sniffImageType } from "../src/lib/image"
import { OPTIMIZED_IMAGE_MAX_EDGE } from "../src/lib/image-optimizer"
import { cloudflareImageOptimizer, type ImagesBindingLike } from "../src/lib/image-optimizer-cf"

describe("cloudflareImageOptimizer", () => {
  it("uses a scale-down transform and preserves the source format", async () => {
    const transformed = vi.fn()
    const output = vi.fn(async () => ({
      response: () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])),
    }))
    const chain = { transform: transformed, output }
    transformed.mockReturnValue(chain)
    const binding = {
      input: vi.fn(() => chain),
    } as unknown as ImagesBindingLike

    const result = await cloudflareImageOptimizer(binding)(
      new Uint8Array([0xff, 0xd8, 0xff, 9, 9, 9, 9, 9]),
      "image/jpeg",
    )

    expect(transformed).toHaveBeenCalledWith({
      width: OPTIMIZED_IMAGE_MAX_EDGE,
      height: OPTIMIZED_IMAGE_MAX_EDGE,
      fit: "scale-down",
      metadata: "none",
    })
    expect(output).toHaveBeenCalledWith({ format: "image/jpeg", quality: 82 })
    expect(sniffImageType(result)).toBe("image/jpeg")
  })

  it("surfaces a failed binding response", async () => {
    const chain = {
      transform: vi.fn(),
      output: vi.fn(async () => ({ response: () => new Response(null, { status: 503 }) })),
    }
    chain.transform.mockReturnValue(chain)
    const binding = { input: vi.fn(() => chain) } as unknown as ImagesBindingLike
    await expect(
      cloudflareImageOptimizer(binding)(
        new Uint8Array([0x47, 0x49, 0x46, 0x38, 0, 0]),
        "image/gif",
      ),
    ).rejects.toThrow("503")
  })
})

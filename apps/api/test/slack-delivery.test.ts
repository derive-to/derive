import type { MetaStore } from "@derive/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { postWithRecovery } from "../src/lib/slack-delivery"

afterEach(() => vi.unstubAllGlobals())

describe("Slack Work Object recovery", () => {
  it.each([
    "invalid_metadata_schema",
    "error_processing_metadata",
  ])("falls back to Block Kit when Slack rejects entity metadata with %s", async (metadataError) => {
    const posted: Record<string, unknown>[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        posted.push(body)
        if (posted.length === 1)
          return new Response(JSON.stringify({ ok: false, error: metadataError }))
        return new Response(JSON.stringify({ ok: true, ts: "1.1", channel: "D1" }))
      }),
    )

    const r = await postWithRecovery(
      {} as MetaStore,
      "org",
      "xoxb-token",
      {
        channel: "D1",
        text: "A mention",
        blocks: [{ type: "section" }],
        metadata: { entities: [{ external_ref: { id: "th_1" } }] },
      },
      { metadataFallback: true },
    )

    expect(r).toMatchObject({ ok: true, status: expect.stringContaining("blocks-only") })
    expect(posted).toHaveLength(2)
    expect(posted[0]?.metadata).toBeTruthy()
    expect(posted[1]?.metadata).toBeUndefined()
  })

  it("keeps entity metadata when only the Block Kit payload is invalid", async () => {
    const posted: Record<string, unknown>[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        posted.push(body)
        if (posted.length === 1)
          return new Response(JSON.stringify({ ok: false, error: "invalid_blocks" }))
        return new Response(JSON.stringify({ ok: true, ts: "1.1", channel: "D1" }))
      }),
    )

    const r = await postWithRecovery(
      {} as MetaStore,
      "org",
      "xoxb-token",
      {
        channel: "D1",
        text: "A mention",
        blocks: [{ type: "not-a-real-block" }],
        metadata: { entities: [{ external_ref: { id: "th_1" } }] },
      },
      { metadataFallback: true, textFallback: true },
    )

    expect(r).toMatchObject({ ok: true, status: expect.stringContaining("text-only") })
    expect(posted).toHaveLength(2)
    expect(posted[1]?.blocks).toBeUndefined()
    expect(posted[1]?.metadata).toBeTruthy()
  })
})

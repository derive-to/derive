import { describe, expect, it } from "vitest"
import { OrtamClient, ortamId } from "../src/lib/ortam-client"

describe("Ortam IDs", () => {
  it("re-encodes a bare UUID as Ortam's public ID, per the TypeID spec", () => {
    expect(ortamId("sbx", "01890a5d-ac96-774b-bcce-b302099a8057")).toBe(
      "sbx_01h455vb4pex5vsknk084sn02q",
    )
    expect(ortamId("sbx", "00000000-0000-0000-0000-000000000000")).toBe(
      "sbx_00000000000000000000000000",
    )
    expect(ortamId("op", "ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(
      "op_7zzzzzzzzzzzzzzzzzzzzzzzzz",
    )
    expect(ortamId("sbx", "sbx_325h5hmfmy8m4t5ynfdyfzfv2d")).toBe("sbx_325h5hmfmy8m4t5ynfdyfzfv2d")
  })

  it("reaches a sandbox saved under its old UUID by its public ID", async () => {
    const identity = { organization_id: "org", user_id: "usr" }
    const paths: string[] = []
    const fetcher = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      if (path === "/v1/integration") return Response.json(identity)
      return Response.json({
        id: "sbx_01h455vb4pex5vsknk084sn02q",
        state: "stopped",
        current_operation_id: null,
        auto_stop_after_seconds: 1200,
      })
    }) as typeof fetch
    const client = new OrtamClient("https://ortam.test/v1", "key", "subject", fetcher)
    const sandbox = await client.sandbox("01890a5d-ac96-774b-bcce-b302099a8057", identity)
    expect(sandbox.state).toBe("stopped")
    expect(paths).toContain("/v1/sandboxes/sbx_01h455vb4pex5vsknk084sn02q")
  })
})

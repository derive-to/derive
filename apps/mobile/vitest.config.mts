import { defineConfig } from "vitest/config"

// The shell's pure logic — deep-link resolution, the auth nonce binding, and the injected
// background probe. Everything device-shaped (the web view itself, gestures, the auth
// browser) is out of reach here and is covered by running it on a phone; this gate is
// scoped to the parts that CAN be checked, so a regression in them fails before a handset
// has to find it.
//
// jsdom, not node: the probe is a script that runs in a document, so testing it needs one.
export default defineConfig({
  test: { environment: "jsdom", include: ["src/**/*.test.ts"] },
})

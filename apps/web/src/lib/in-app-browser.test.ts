import { describe, expect, it } from "vitest"
import { appDeepLink, isEmbeddedMobileBrowser } from "./in-app-browser"

const SLACK_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Slack/25.06.10 Mobile/15E148"
const SLACK_ANDROID =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 Slack/25.06.10"
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"
const CHROME_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const SLACK_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Slack/4.41.aa Chrome/128.0.6613.36 Electron/32.2.5 Safari/537.36"

describe("isEmbeddedMobileBrowser", () => {
  it("detects Slack's in-app browser, the case this exists for", () => {
    expect(isEmbeddedMobileBrowser(SLACK_IOS)).toBe(true)
    expect(isEmbeddedMobileBrowser(SLACK_ANDROID)).toBe(true)
  })

  it("leaves a real mobile browser alone", () => {
    // Safari CAN reach the app through a universal link, so the bar would be noise.
    expect(isEmbeddedMobileBrowser(SAFARI_IOS)).toBe(false)
  })

  it("never fires on desktop, where there is no app to open", () => {
    expect(isEmbeddedMobileBrowser(CHROME_DESKTOP)).toBe(false)
    // Slack's own desktop client is still a desktop: it must NOT match, even though
    // the UA carries the Slack marker the mobile check keys off.
    expect(isEmbeddedMobileBrowser(SLACK_DESKTOP)).toBe(false)
  })

  it("matches case-insensitively", () => {
    expect(isEmbeddedMobileBrowser(SLACK_IOS.toUpperCase())).toBe(true)
  })

  it("treats an empty or junk user agent as not embedded", () => {
    expect(isEmbeddedMobileBrowser("")).toBe(false)
    expect(isEmbeddedMobileBrowser("curl/8.7.1")).toBe(false)
  })
})

describe("appDeepLink", () => {
  it("hands the whole https url to the app on the custom scheme", () => {
    expect(appDeepLink("https://derive.to/artifacts/plan-fbgvc16u")).toBe(
      "derive://open?url=https%3A%2F%2Fderive.to%2Fartifacts%2Fplan-fbgvc16u",
    )
  })

  it("encodes a query string so the app receives it intact", () => {
    // The nested ?comment= must survive as data, not become a second parameter of
    // the deep link itself.
    const link = appDeepLink("https://derive.to/artifacts/abc?comment=c_1&v=3")
    expect(link).toContain("%3Fcomment%3Dc_1%26v%3D3")
    expect(link.match(/\?/g)).toHaveLength(1)
  })
})

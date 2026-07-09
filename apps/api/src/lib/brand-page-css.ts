// Shared :root tokens + fonts for the server-rendered brand pages (OAuth consent,
// CLI callback, GitHub-App setup). These are standalone HTML served outside the
// SPA, so they can't read the app's [data-theme] tokens — this mirrors the Derive
// palette (neutral, monochrome) and follows the viewer's OS colour scheme: light by
// default, dark via prefers-color-scheme. Each page appends its own component CSS.
//
// Geist (the app's one typeface) is self-hosted inline as a data URI — NO third-party
// font request. A user authorizing an agent never leaks their IP to Google Fonts at the
// consent moment, and the pages render identically under a strict CSP / on an air-gapped
// self-host, all on-brand (Geist, not the old Inter).
import { GEIST_LATIN_WOFF2 } from "./brand-page-font"

export const BRAND_PAGE_TOKENS = `
  @font-face{font-family:"Geist";font-style:normal;font-weight:100 900;font-display:swap;
    src:url("${GEIST_LATIN_WOFF2}") format("woff2")}
  :root{
    --paper:#f7f8fa;--panel:#ffffff;--panel-2:#eef1f4;--ink:#14161a;--ink-soft:#40444c;
    --muted:#6b7079;--line:#e5e7eb;--line-2:#eef0f3;--accent:#14161a;--accent-fg:#f7f8fa;
    --accent-ink:#14161a;--accent-2:#5c616b;--accent-soft:#eceef2;--good:#2f7d4f;
    --good-soft:#e6f1ea;--bad:#b4402c;
    --display:"Geist",ui-sans-serif,system-ui,sans-serif;
    --sans:"Geist",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  }
  @media(prefers-color-scheme:dark){:root{
    --paper:#0a0b0d;--panel:#101216;--panel-2:#16181d;--ink:#f3f4f6;--ink-soft:#c2c5cc;
    --muted:#8b8f98;--line:#23252b;--line-2:#1b1e22;--accent:#f3f4f6;--accent-fg:#0a0b0d;
    --accent-ink:#f3f4f6;--accent-2:#8b8f98;--accent-soft:#1b1e22;--good:#74b085;
    --good-soft:#131c17;--bad:#d98c74;
  }}`

// The Derive mark for the brand pages — monochrome, `currentColor` so it takes the
// page's ink. Size it via the `.mk` rule (height-based; the mark is portrait).
export const BRAND_PAGE_MARK = `<svg class="mk" viewBox="0 0 620 824" fill="none" aria-hidden="true"><path d="M404.01 217.285L271.071 140.531L404.01 63.7773L536.95 140.531L404.01 217.285ZM343.201 686.623L343.063 686.703C298.797 712.261 243.462 680.313 243.462 629.197C243.462 605.464 256.131 583.533 276.691 571.677L348.791 530.099V466.183L215.853 542.936L83.0526 466.183L243.462 373.692V188.295L376.401 265.049V629.119C376.401 652.841 363.746 674.761 343.201 686.623ZM188.243 744.209L55.4433 667.455V514.085L188.243 590.839V744.209ZM404.01 -1.19209e-05L188.243 124.517V341.803L0.224609 450.308V699.344L215.853 824L431.619 699.344V303.385C431.619 279.663 444.275 257.743 464.819 245.88L464.957 245.801C509.225 220.243 564.559 252.189 564.559 303.305V303.444C564.559 327.179 551.89 349.108 531.329 360.965L459.229 402.544V466.321L619.777 373.692V124.517L404.01 -1.19209e-05Z" fill="currentColor"/></svg>`

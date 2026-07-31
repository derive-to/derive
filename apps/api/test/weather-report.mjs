// Renders the weather-watch page that the MCP walkthrough writes into a Derive artifact.
//
// Lives in one file because two callers produce the same document: live-preview-weather.sh
// (against a deployment) and weather-artifact.manual.ts (in process). A presentation template
// duplicated across a shell heredoc and a TypeScript string diverges the first time either is
// touched, and then the "same" end-to-end proof produces two different pages.
//
// Self-contained on purpose: no external fonts, stylesheets or images. The artifact viewer is
// sandboxed, and a page that needs the network to look right is a page that eventually does not.
//
//   import { renderWeatherReport } from "./weather-report.mjs"
//   echo '[{...}]' | node weather-report.mjs --source https://…/mcp --via https://…

/**
 * @typedef {object} Reading
 * @property {string} place
 * @property {number} temperature_c
 * @property {number} wind_kph
 * @property {string} condition
 * @property {string} observed_at
 * @property {string} [source]
 */

/** Condition keyword → one inline SVG. Inline so the page carries its own art. */
const ICONS = {
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.6M12 19.4V22M2 12h2.6M19.4 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/>',
  cloud: '<path d="M7.2 19h9.4a4 4 0 0 0 .5-8 6 6 0 0 0-11.5 1.6A3.7 3.7 0 0 0 7.2 19Z"/>',
  rain: '<path d="M7.4 15.5h9.2a3.7 3.7 0 0 0 .4-7.4 5.6 5.6 0 0 0-10.7 1.5 3.4 3.4 0 0 0 1.1 5.9Z"/><path d="M9 18.2l-.9 2.3M13 18.2l-.9 2.3M17 18.2l-.9 2.3"/>',
  snow: '<path d="M7.4 15.5h9.2a3.7 3.7 0 0 0 .4-7.4 5.6 5.6 0 0 0-10.7 1.5 3.4 3.4 0 0 0 1.1 5.9Z"/><path d="M9 19h.01M13 19h.01M17 19h.01M11 21.4h.01M15 21.4h.01"/>',
  fog: '<path d="M6.6 12.4h9.8a3.6 3.6 0 0 0 .4-7.2A5.5 5.5 0 0 0 6.3 6.7a3.3 3.3 0 0 0 .3 5.7Z"/><path d="M4 16h16M6 19.4h12"/>',
  storm:
    '<path d="M7.4 14.6h9.2a3.7 3.7 0 0 0 .4-7.4A5.6 5.6 0 0 0 6.3 8.7a3.4 3.4 0 0 0 1.1 5.9Z"/><path d="M13 15.4l-2.6 4h3.2l-2.2 3.4"/>',
}

/** Map a server's plain-language condition onto an icon + a mood class. */
const look = (condition) => {
  const c = String(condition).toLowerCase()
  if (c.includes("thunder")) return { icon: "storm", mood: "storm" }
  if (c.includes("snow")) return { icon: "snow", mood: "cold" }
  if (c.includes("rain") || c.includes("drizzle") || c.includes("shower"))
    return { icon: "rain", mood: "wet" }
  if (c.includes("fog") || c.includes("rime")) return { icon: "fog", mood: "grey" }
  if (c.includes("overcast") || c.includes("cloud")) return { icon: "cloud", mood: "grey" }
  return { icon: "sun", mood: "clear" }
}

/** Temperature band, so a card reads at a glance rather than needing the number parsed. */
const band = (t) =>
  t <= 0 ? "freezing" : t < 10 ? "cold" : t < 20 ? "mild" : t < 28 ? "warm" : "hot"

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  )

/** "2026-07-31T01:00" → "01:00 · 31 Jul". Kept dependency-free and UTC-honest. */
const stamp = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso))
  if (!m) return esc(iso)
  const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")
  return `${m[4]}:${m[5]} &middot; ${Number(m[3])} ${months[Number(m[2]) - 1]}`
}

const card = (r) => {
  const { icon, mood } = look(r.condition)
  const [city, ...rest] = String(r.place).split(",")
  return `      <article class="card ${band(r.temperature_c)}">
        <div class="mood ${mood}" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
               stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</svg>
        </div>
        <h2>${esc(city.trim())}</h2>
        <p class="where">${esc(rest.join(",").trim() || "&nbsp;")}</p>
        <p class="temp">${esc(r.temperature_c)}<span>&deg;C</span></p>
        <p class="cond">${esc(r.condition)}</p>
        <dl class="rows">
          <div><dt>Wind</dt><dd>${esc(r.wind_kph)} km/h</dd></div>
          <div><dt>Observed</dt><dd>${stamp(r.observed_at)}</dd></div>
        </dl>
      </article>`
}

/**
 * @param {Reading[]} readings
 * @param {{ server?: string, deployment?: string, run?: string }} [meta]
 * @returns {string} a complete, self-contained HTML page
 */
export const renderWeatherReport = (readings, meta = {}) => {
  const upstream = readings.find((r) => r.source)?.source ?? "the connected server"
  // A data slot makes this page a time series instead of thirty pages to re-parse: republish on a
  // schedule and `read(data:"readings", versions:"all")` hands back the history. `</script>` is
  // escaped because HTML would end the block early, exactly as a browser does.
  const slot = JSON.stringify({ readings, server: meta.server ?? null }, null, 1).replace(
    /<\/script>/gi,
    "<\\/script>",
  )
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Weather watch</title>
<style>
  :root {
    --bg:#fbfbfc; --panel:#fff; --fg:#141417; --fg-2:#3f3f48; --muted:#74747f;
    --line:#e8e8ed; --accent:#4c5fd7;
    --clear:#e8a317; --grey:#7c8494; --wet:#3f7fbf; --cold:#5aa9d6; --storm:#7a5cc4;
    --shadow:0 1px 2px rgba(20,20,25,.05), 0 10px 30px -14px rgba(20,20,25,.18);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0c0c0e; --panel:#151519; --fg:#f2f2f6; --fg-2:#c8c8d1; --muted:#8b8b99;
      --line:#26262e; --accent:#93a4ff;
      --clear:#f0b429; --grey:#98a0b0; --wet:#63a6e8; --cold:#7cc6ef; --storm:#a48ae8;
      --shadow:0 1px 2px rgba(0,0,0,.5), 0 14px 36px -16px rgba(0,0,0,.8);
    }
  }
  :root[data-theme="dark"] {
    --bg:#0c0c0e; --panel:#151519; --fg:#f2f2f6; --fg-2:#c8c8d1; --muted:#8b8b99;
    --line:#26262e; --accent:#93a4ff;
    --clear:#f0b429; --grey:#98a0b0; --wet:#63a6e8; --cold:#7cc6ef; --storm:#a48ae8;
    --shadow:0 1px 2px rgba(0,0,0,.5), 0 14px 36px -16px rgba(0,0,0,.8);
  }
  :root[data-theme="light"] {
    --bg:#fbfbfc; --panel:#fff; --fg:#141417; --fg-2:#3f3f48; --muted:#74747f;
    --line:#e8e8ed; --accent:#4c5fd7;
    --clear:#e8a317; --grey:#7c8494; --wet:#3f7fbf; --cold:#5aa9d6; --storm:#7a5cc4;
    --shadow:0 1px 2px rgba(20,20,25,.05), 0 10px 30px -14px rgba(20,20,25,.18);
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--bg); color:var(--fg);
    font:16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .wrap { max-width:940px; margin:0 auto; padding:64px 24px 80px; }
  .eyebrow {
    display:inline-flex; align-items:center; gap:8px; font-size:.72rem; font-weight:650;
    letter-spacing:.11em; text-transform:uppercase; color:var(--accent);
    background:color-mix(in srgb, var(--accent) 10%, transparent);
    padding:6px 12px; border-radius:999px; margin-bottom:20px;
  }
  .eyebrow b { width:6px; height:6px; border-radius:50%; background:currentColor; }
  h1 {
    font-size:clamp(2rem,5vw,2.85rem); line-height:1.05; letter-spacing:-.033em;
    font-weight:700; margin:0 0 14px;
  }
  .lede { color:var(--muted); font-size:1.08rem; margin:0 0 44px; max-width:52ch; }
  .lede code {
    font:0.86em ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--fg-2);
    background:color-mix(in srgb, var(--fg) 6%, transparent); padding:.14em .4em; border-radius:5px;
  }

  .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(238px,1fr)); gap:18px; }
  .card {
    position:relative; background:var(--panel); border:1px solid var(--line);
    border-radius:16px; padding:24px 22px 20px; box-shadow:var(--shadow); overflow:hidden;
  }
  .card::before {
    content:""; position:absolute; inset:0 0 auto 0; height:3px;
    background:linear-gradient(90deg, var(--tint), transparent 85%);
  }
  .card.freezing { --tint:var(--cold); }
  .card.cold     { --tint:var(--cold); }
  .card.mild     { --tint:var(--grey); }
  .card.warm     { --tint:var(--clear); }
  .card.hot      { --tint:#e2683c; }

  .mood { width:34px; height:34px; margin-bottom:16px; }
  .mood svg { width:100%; height:100%; display:block; }
  .mood.clear { color:var(--clear); } .mood.grey { color:var(--grey); }
  .mood.wet { color:var(--wet); } .mood.cold { color:var(--cold); }
  .mood.storm { color:var(--storm); }

  .card h2 { font-size:1.12rem; font-weight:650; letter-spacing:-.012em; margin:0; }
  .where { color:var(--muted); font-size:.83rem; margin:2px 0 14px; }
  .temp {
    font-size:3rem; font-weight:660; letter-spacing:-.045em; line-height:1;
    margin:0 0 6px; font-variant-numeric:tabular-nums;
  }
  .temp span { font-size:1.15rem; font-weight:500; color:var(--muted); letter-spacing:0; margin-left:2px; }
  .cond { color:var(--fg-2); font-size:.95rem; margin:0 0 18px; text-transform:lowercase; }

  .rows { margin:0; padding-top:14px; border-top:1px solid var(--line); }
  .rows div { display:flex; justify-content:space-between; gap:12px; padding:3px 0; }
  .rows dt { color:var(--muted); font-size:.83rem; margin:0; }
  .rows dd {
    margin:0; font-size:.83rem; font-weight:550; color:var(--fg-2);
    font-variant-numeric:tabular-nums;
  }

  footer {
    margin-top:44px; padding-top:22px; border-top:1px solid var(--line);
    color:var(--muted); font-size:.85rem; line-height:1.65;
  }
  footer code {
    font:0.86em ui-monospace, SFMono-Regular, Menlo, monospace;
    background:color-mix(in srgb, var(--fg) 6%, transparent); padding:.14em .4em; border-radius:5px;
  }
</style>
</head>
<body>
  <div class="wrap">
    <span class="eyebrow"><b></b>Live from a connected source</span>
    <h1>Weather watch</h1>
    <p class="lede">Every figure below was read during this run from a Model Context Protocol server, through Derive's tool proxy. The agent called <code>get_current_weather</code> by name and never held the server's URL or its credential.</p>

    <div class="grid">
${readings.map(card).join("\n")}
    </div>

    <footer>
      Source <code>${esc(meta.server ?? "a connected MCP server")}</code> &middot; upstream data from ${esc(upstream)}${
        meta.deployment ? `<br>Read on <code>${esc(meta.deployment)}</code>` : ""
      }${meta.run ? ` &middot; run <code>${esc(meta.run)}</code>` : ""}
    </footer>
  </div>

  <script type="application/derive-data" data-slot="readings">
${slot}
  </script>
</body>
</html>
`
}

// CLI: readings JSON on stdin, page on stdout.
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  let raw = ""
  process.stdin.setEncoding("utf8")
  for await (const chunk of process.stdin) raw += chunk
  process.stdout.write(
    renderWeatherReport(JSON.parse(raw || "[]"), {
      server: arg("source"),
      deployment: arg("via"),
      run: arg("run"),
    }),
  )
}

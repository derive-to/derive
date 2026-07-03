import { Buffer } from "node:buffer"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { type Page, test } from "@playwright/test"
import { signUp } from "../helpers"

// Visual-QA capture harness for the real, auth-walled dashboard — derive's answer
// to Nemonic's scripts/screenshot.mjs, but riding the existing e2e server auto-boot
// (playwright.config.ts webServer) and the signUp helper instead of a wrangler
// /__dev/seed endpoint. It signs up a fresh isolated user, seeds a realistic
// workspace of self-contained HTML + markdown artifacts (so the card thumbnails —
// which are LIVE /raw iframes, not pre-baked PNGs — actually render), then captures
// the library, favorites, and an artifact across dark/light × desktop/mobile.
//
// Not a test gate: self-skips unless SHOTS=1, so a bare `playwright test` ignores it.
//   SHOTS=1 SHOT_OUT=/tmp/shots npx playwright test --project=screens
//
// Output dir: SHOT_OUT (default test-results/screens).

const OUT = process.env.SHOT_OUT ?? join(process.cwd(), "test-results", "screens")
const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }
const THEMES = ["dark", "light"] as const

test.use({ deviceScaleFactor: 2, viewport: DESKTOP })

// A self-contained page (inline styles only — the card iframe is sandboxed and
// same-origin /raw, so no external fonts/images) that renders as a believable
// artifact thumbnail.
const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
    *{box-sizing:border-box;margin:0;font-family:ui-sans-serif,system-ui,sans-serif}
    body{padding:40px;color:#0b0d12}
  </style></head><body>${body}</body></html>`

const SEEDS: { name: string; type: string; body: string }[] = [
  {
    name: "launch-hero.html",
    type: "text/html",
    body: page(
      "Launch",
      `<div style="min-height:88vh;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;background:radial-gradient(120% 80% at 50% -10%,#1b2340,#0b0d12);color:#fff;border-radius:20px;padding:60px">
        <div style="font:600 13px ui-monospace,monospace;letter-spacing:.2em;text-transform:uppercase;color:#f0aa37">Fall release</div>
        <h1 style="font-size:64px;font-weight:700;letter-spacing:-.03em;margin:18px 0">Ship it beautifully.</h1>
        <p style="font-size:22px;color:#9ca3b5;max-width:560px">One link for every version, comment, and reaction — from the tools you already use.</p>
        <div style="margin-top:34px;display:flex;gap:12px"><div style="background:#f0aa37;color:#111;padding:14px 26px;border-radius:10px;font-weight:600">Get started</div><div style="border:1px solid #333;color:#fff;padding:14px 26px;border-radius:10px">Docs</div></div>
      </div>`,
    ),
  },
  {
    name: "pricing.html",
    type: "text/html",
    body: page(
      "Pricing",
      `<div style="max-width:900px;margin:0 auto"><h1 style="font-size:34px;font-weight:700;letter-spacing:-.02em;text-align:center;margin-bottom:32px">Simple pricing</h1>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">
        ${["Free", "Pro", "Team"]
          .map(
            (
              t,
              i,
            ) => `<div style="border:1px solid ${i === 1 ? "#f0aa37" : "#e2e4ea"};border-radius:16px;padding:26px;${i === 1 ? "box-shadow:0 20px 50px -20px rgba(240,170,55,.5)" : ""}">
          <div style="font-weight:600;color:#6b7280">${t}</div>
          <div style="font-size:40px;font-weight:700;margin:10px 0">$${i * 12}</div>
          ${[1, 2, 3].map(() => `<div style="display:flex;gap:8px;color:#4b5563;margin:10px 0"><span style="color:#22c55e">✓</span> Feature line</div>`).join("")}
          <div style="margin-top:18px;background:${i === 1 ? "#111" : "#f4f5f8"};color:${i === 1 ? "#fff" : "#111"};text-align:center;padding:12px;border-radius:10px;font-weight:600">Choose</div>
        </div>`,
          )
          .join("")}
      </div></div>`,
    ),
  },
  {
    name: "metrics-dashboard.html",
    type: "text/html",
    body: page(
      "Metrics",
      `<div style="background:#f4f5f8;padding:30px;border-radius:16px">
        <h2 style="font-size:22px;font-weight:700;margin-bottom:20px">This week</h2>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:24px">
          ${[
            ["Views", "12.4k", "#3b82f6"],
            ["Signups", "482", "#22c55e"],
            ["Revenue", "$9.1k", "#f0aa37"],
            ["Churn", "1.2%", "#ef4444"],
          ]
            .map(
              ([l, v, c]) =>
                `<div style="background:#fff;border-radius:12px;padding:18px;box-shadow:0 1px 3px rgba(0,0,0,.06)"><div style="color:#6b7280;font-size:13px">${l}</div><div style="font-size:26px;font-weight:700;color:${c}">${v}</div></div>`,
            )
            .join("")}
        </div>
        <div style="background:#fff;border-radius:12px;padding:22px;box-shadow:0 1px 3px rgba(0,0,0,.06)">
          <div style="display:flex;align-items:flex-end;gap:10px;height:160px">
            ${[40, 70, 55, 90, 65, 120, 85, 100, 60, 140].map((h) => `<div style="flex:1;height:${h}px;background:linear-gradient(#60a5fa,#3b82f6);border-radius:6px 6px 0 0"></div>`).join("")}
          </div>
        </div>
      </div>`,
    ),
  },
  {
    name: "changelog.html",
    type: "text/html",
    body: page(
      "Changelog",
      `<div style="max-width:640px;margin:0 auto"><h1 style="font-size:30px;font-weight:700;letter-spacing:-.02em">Changelog</h1>
      ${[
        ["Comments 2.0", "#8781b0"],
        ["Faster search", "#5f9a90"],
        ["Dark mode", "#6b8bac"],
      ]
        .map(
          ([
            t,
            c,
          ]) => `<div style="border-left:2px solid ${c};padding:6px 0 26px 20px;margin-top:20px;position:relative">
        <div style="position:absolute;left:-5px;top:8px;width:8px;height:8px;border-radius:50%;background:${c}"></div>
        <div style="font-size:12px;color:#9ca3b5">Jun 2026</div><div style="font-size:19px;font-weight:600;margin:4px 0">${t}</div>
        <p style="color:#4b5563">A short paragraph about what shipped and why it matters to the people using it every day.</p></div>`,
        )
        .join("")}</div>`,
    ),
  },
  {
    name: "profile-card.html",
    type: "text/html",
    body: page(
      "Profile",
      `<div style="min-height:80vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#fdf0e6,#eef2f9)">
        <div style="background:#fff;border-radius:20px;padding:34px;width:340px;text-align:center;box-shadow:0 30px 60px -20px rgba(0,0,0,.2)">
          <div style="width:84px;height:84px;border-radius:50%;margin:0 auto;background:linear-gradient(135deg,#f0aa37,#e99421)"></div>
          <div style="font-size:22px;font-weight:700;margin-top:16px">Ana Lima</div>
          <div style="color:#9ca3b5">Design Lead</div>
          <div style="display:flex;gap:10px;margin-top:22px">${["Follow", "Message"].map((t, i) => `<div style="flex:1;padding:11px;border-radius:10px;font-weight:600;background:${i ? "#f4f5f8" : "#111"};color:${i ? "#111" : "#fff"}">${t}</div>`).join("")}</div>
        </div>
      </div>`,
    ),
  },
  {
    name: "email-template.html",
    type: "text/html",
    body: page(
      "Email",
      `<div style="max-width:520px;margin:0 auto;border:1px solid #eee;border-radius:14px;overflow:hidden">
        <div style="background:#111;color:#fff;padding:26px;font-size:20px;font-weight:700">Derive</div>
        <div style="padding:30px"><h2 style="font-size:22px;margin-bottom:12px">You've been invited</h2>
        <p style="color:#4b5563;line-height:1.6">Rob shared <b>Q3 board review</b> with you. Open it to leave feedback, react, and follow every new version.</p>
        <div style="margin-top:22px;background:#f0aa37;color:#111;display:inline-block;padding:13px 24px;border-radius:10px;font-weight:600">Open artifact</div></div>
      </div>`,
    ),
  },
  {
    name: "q3-board-review.md",
    type: "text/markdown",
    body: `# Q3 board review\n\n## Highlights\n\n- Revenue up **28%** quarter over quarter\n- Two enterprise logos signed\n- NPS climbed from 41 to 52\n\n## Risks\n\n1. Hiring pace behind plan\n2. Infra costs scaling with usage\n\n> The team shipped the collaboration release on time.\n\n\`\`\`ts\nconst growth = (q3 - q2) / q2 // 0.28\n\`\`\`\n`,
  },
  {
    name: "spec-notes.md",
    type: "text/markdown",
    body: `# Editor spec\n\nDefine the comment anchoring model and the version diff view.\n\n- [x] Anchor comments to document ranges\n- [x] Optimistic posting\n- [ ] Presence cursors in the diff view\n\nSee the [design doc](#) for the full rationale and the open questions we still need to resolve before build.\n`,
  },
  {
    name: "onboarding.md",
    type: "text/markdown",
    body: `# Onboarding checklist\n\nWelcome aboard! Work through these in your first week.\n\n1. Connect your GitHub\n2. Publish your first artifact\n3. Invite a teammate\n4. Set up a collection\n\nEverything you publish gets a permanent, versioned URL you can share anywhere.\n`,
  },
]

async function publish(p: Page, s: { name: string; type: string; body: string }): Promise<string> {
  const res = await p.request.post("/v1/artifacts", {
    multipart: { file: { name: s.name, mimeType: s.type, buffer: Buffer.from(s.body) } },
  })
  if (!res.ok()) throw new Error(`publish ${s.name} failed: ${res.status()}`)
  return ((await res.json()) as { short_id: string }).short_id
}

const settle = async (p: Page, ms = 1800) => {
  await p.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {})
  await p.evaluate(() => document.fonts.ready).catch(() => {})
  await p.waitForTimeout(ms) // live /raw iframes need time to paint
}

test("capture the dashboard across themes and viewports", async ({ page: p }) => {
  test.skip(!process.env.SHOTS, "visual-QA harness — run with SHOTS=1 --project=screens")
  test.setTimeout(180_000)
  mkdirSync(OUT, { recursive: true })

  await signUp(p)

  // Seed a realistic library, newest-last so the grid reads varied.
  const ids: string[] = []
  for (const s of SEEDS) ids.push(await publish(p, s))

  // Republish one artifact twice so a card carries version history — exercises
  // the v{n} placard and the stacked version-deck under-edges on its frame.
  const s = SEEDS[2]
  if (!s) throw new Error("SEEDS[2] missing — the seed list shrank")
  for (const n of [2, 3]) {
    const res = await p.request.post(`/v1/artifacts/${ids[2]}/versions`, {
      multipart: {
        file: { name: s.name, mimeType: s.type, buffer: Buffer.from(s.body) },
        message: `revision ${n}`,
      },
    })
    if (!res.ok()) throw new Error(`republish v${n} failed: ${res.status()}`)
  }

  await p.goto("/")
  await settle(p)

  // The rail is expanded by default, so the nav (warm active bar, section labels,
  // search field) is in view. Favorite a couple of cards for a populated rail.
  for (const id of [ids[0], ids[2]]) {
    await p
      .getByTestId(`artifact-card-favorite-${id}`)
      .click({ timeout: 5000 })
      .catch(() => {})
  }
  // A collection, for a populated sidebar.
  await p
    .getByTestId("sidebar-new-collection")
    .click()
    .catch(() => {})
  await p
    .getByTestId("sidebar-new-collection-input")
    .fill("Specs")
    .catch(() => {})
  await p
    .getByTestId("sidebar-new-collection-input")
    .press("Enter")
    .catch(() => {})

  const shot = async (name: string, opts: { fullPage?: boolean } = {}) => {
    await p.screenshot({ path: join(OUT, `${name}.png`), fullPage: opts.fullPage ?? false })
    console.log(`✓ ${name}`)
  }

  for (const theme of THEMES) {
    await p.evaluate((t) => localStorage.setItem("derive_theme", t), theme)

    // Desktop
    await p.setViewportSize(DESKTOP)
    await p.goto("/")
    await settle(p)
    await shot(`library-${theme}-desktop`)

    // Card hover — verify the render "wakes" (glare-dim clears) + shadow lift.
    if (theme === "dark") {
      await p
        .getByTestId(`artifact-card-open-${ids[2]}`)
        .hover()
        .catch(() => {})
      await p.waitForTimeout(400)
      await shot("library-dark-desktop-hover")
    }

    // Favorites filter view
    await p
      .getByTestId("sidebar-favorites")
      .click()
      .catch(() => {})
    await settle(p, 1200)
    await shot(`favorites-${theme}-desktop`)

    // An artifact page (open the metrics dashboard — visual render)
    await p.goto(`/artifacts/${ids[2]}`)
    await settle(p)
    await shot(`artifact-${theme}-desktop`)

    // Mobile home
    await p.setViewportSize(MOBILE)
    await p.goto("/")
    await settle(p)
    await shot(`library-${theme}-mobile`)
  }
})

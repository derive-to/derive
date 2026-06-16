import { Buffer } from "node:buffer"
import { expect, test } from "../fixtures"

// Adversarial coverage for deck-aware comment anchoring. The risky code is the
// in-iframe ANCHOR_CLIENT_JS slide-scoped resolver: it must pin a comment to the
// slide its text REALLY lives on — scoping to the recorded slide first (so the same
// phrase on two slides can't collide), falling back to a whole-document search when
// the text has moved, and reporting the landed slide back to the host. The "Slide N"
// badge on each card is a direct readout of that landed slide, so we attack the
// resolver through crafted anchors and assert the badge.

// A protocol-speaking deck. All slides live in the DOM (inactive ones display:none),
// so the resolver can find text on any slide; `data-dock-slide` is the stable index.
const deckHtml = (slides: string[]) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Deck</title>
<style>
  html,body{height:100%;margin:0}
  .slide{position:absolute;inset:0;display:none;padding:6vh 8vw;font:20px system-ui}
  .slide.on{display:block}
</style></head>
<body>
<main class="deck">
${slides.map((s, i) => `  <section class="slide${i === 0 ? " on" : ""}" data-dock-slide="${i}"><h2>Slide ${i + 1}</h2><p>${s}</p></section>`).join("\n")}
</main>
<script>
(function(){
  var slides=[].slice.call(document.querySelectorAll('.slide')),i=0;
  function report(){try{parent.postMessage({source:'dock-deck',type:'state',i:i,total:slides.length},'*')}catch(e){}}
  function show(n){i=Math.max(0,Math.min(slides.length-1,n));slides.forEach(function(s,k){s.classList.toggle('on',k===i)});report()}
  window.addEventListener('message',function(e){var d=e.data;if(!d||d.source!=='dock-host'||d.type!=='deck')return;
    if(d.action==='next')show(i+1);else if(d.action==='prev')show(i-1);else if(d.action==='goto')show(typeof d.n==='number'?d.n:0)});
  show(0);report();
})();
</script>
</body></html>`

// Publish raw HTML (the shared helper hardcodes text/markdown).
async function publishDeck(page: import("@playwright/test").Page, html: string): Promise<string> {
  let shortId = ""
  await expect(async () => {
    const res = await page.request.post("/v1/artifacts", {
      multipart: { file: { name: "deck.html", mimeType: "text/html", buffer: Buffer.from(html) } },
    })
    expect(res.ok(), `publish failed: ${res.status()}`).toBeTruthy()
    shortId = ((await res.json()) as { short_id: string }).short_id
  }).toPass({ timeout: 10_000 })
  return shortId
}

async function republishDeck(
  page: import("@playwright/test").Page,
  shortId: string,
  html: string,
): Promise<void> {
  await expect(async () => {
    const res = await page.request.post(`/v1/artifacts/${shortId}/versions`, {
      multipart: { file: { name: "deck.html", mimeType: "text/html", buffer: Buffer.from(html) } },
    })
    expect(res.ok(), `republish failed: ${res.status()}`).toBeTruthy()
  }).toPass({ timeout: 10_000 })
}

// Post an anchored comment straight through the API (the same path the UI takes),
// so we control the exact slide + quoted text the resolver is handed.
// Post an anchored comment and return its thread_id (the create response carries
// it directly, so we never depend on the list endpoint's shape).
async function anchorComment(
  page: import("@playwright/test").Page,
  shortId: string,
  body: string,
  exact: string,
  slide: number,
): Promise<string> {
  const res = await page.request.post(`/v1/artifacts/${shortId}/comments`, {
    data: { body_md: body, anchor: { type: "TextQuoteSelector", exact, slide } },
  })
  expect(res.ok(), `comment failed: ${res.status()}`).toBeTruthy()
  return ((await res.json()) as { thread_id: string }).thread_id
}

test.describe("deck comments — slide-scoped anchoring", () => {
  test("resolves duplicate text to the recorded slide, not the first match", async ({ owner }) => {
    // "Shared phrase alpha" appears on BOTH slide 0 and slide 2. A naive global
    // search would wrap the slide-0 occurrence; the scoped resolver must land the
    // slide-2 comment on slide 2.
    const shortId = await publishDeck(
      owner,
      deckHtml([
        "Welcome keynote. Shared phrase alpha here.",
        "Roadmap for the year ahead.",
        "Pricing tiers. Shared phrase alpha again.",
        "Closing thoughts to wrap up.",
        "Appendix with extra details.",
      ]),
    )
    const s0 = await anchorComment(owner, shortId, "on-slide-0", "Welcome keynote", 0)
    const dup = await anchorComment(owner, shortId, "dup-on-slide-2", "Shared phrase alpha", 2)
    const s1 = await anchorComment(owner, shortId, "on-slide-1", "Roadmap for the year", 1)

    await owner.goto(`/a/${shortId}`)
    await expect(owner.getByTestId("deck-position")).toHaveText("1 / 5")

    // The crux: the duplicate-text comment resolves to slide 2 → "Slide 3", NOT the
    // slide-0 occurrence ("Slide 1").
    await expect(owner.getByTestId(`comment-slide-${dup}`)).toHaveText("Slide 3")
    await expect(owner.getByTestId(`comment-slide-${s0}`)).toHaveText("Slide 1")
    await expect(owner.getByTestId(`comment-slide-${s1}`)).toHaveText("Slide 2")
    // Nothing drifted, so nothing is flagged moved.
    await expect(owner.getByTestId(`comment-moved-${dup}`)).toHaveCount(0)
  })

  test("falls back across slides and flags moved when text isn't on its slide", async ({
    owner,
  }) => {
    // "Closing thoughts" is anchored to slide 1 but actually lives on slide 3 → the
    // resolver must fall back, land on slide 3, and flag the drift as moved.
    const shortId = await publishDeck(
      owner,
      deckHtml([
        "Welcome keynote opening.",
        "Roadmap for the year ahead.",
        "Pricing tiers explained here.",
        "Closing thoughts to wrap up.",
        "Appendix with extra details.",
      ]),
    )
    const moved = await anchorComment(owner, shortId, "moved-comment", "Closing thoughts", 1)
    // Out-of-range slide index → global fallback still finds the text (slide 4).
    const oob = await anchorComment(owner, shortId, "oob-comment", "Appendix with extra", 99)

    await owner.goto(`/a/${shortId}`)

    await expect(owner.getByTestId(`comment-slide-${moved}`)).toHaveText("Slide 4")
    await expect(owner.getByTestId(`comment-moved-${moved}`)).toBeVisible()
    // Out-of-range recorded slide, recovered to where the text is (slide 5).
    await expect(owner.getByTestId(`comment-slide-${oob}`)).toHaveText("Slide 5")
  })

  test("clicking an off-slide comment navigates the deck to its slide", async ({ owner }) => {
    const shortId = await publishDeck(
      owner,
      deckHtml(["First slide intro.", "Second slide body.", "Third slide outro."]),
    )
    await anchorComment(owner, shortId, "jump-target", "Third slide outro", 2)

    await owner.goto(`/a/${shortId}`)
    await expect(owner.getByTestId("deck-position")).toHaveText("1 / 3")
    // Activating the card flips the deck to the comment's slide (goto).
    await owner.getByText("jump-target").first().click()
    await expect(owner.getByTestId("deck-position")).toHaveText("3 / 3")
  })

  test("re-pins a comment after a republish moves its text to another slide", async ({ owner }) => {
    const v1 = ["Alpha intro.", "Beta roadmap unique line.", "Gamma outro."]
    const shortId = await publishDeck(owner, deckHtml(v1))
    const id = await anchorComment(owner, shortId, "follows-text", "Beta roadmap unique line", 1)

    await owner.goto(`/a/${shortId}`)
    await expect(owner.getByTestId(`comment-slide-${id}`)).toHaveText("Slide 2")
    await expect(owner.getByTestId(`comment-moved-${id}`)).toHaveCount(0)

    // Republish: the commented line moves from slide 1 (index 1) to slide 3 (index 3).
    const v2 = ["Alpha intro.", "Beta placeholder.", "Gamma outro.", "Beta roadmap unique line."]
    await republishDeck(owner, shortId, deckHtml(v2))
    await owner.reload()

    await expect(owner.getByTestId(`comment-slide-${id}`)).toHaveText("Slide 4")
    await expect(owner.getByTestId(`comment-moved-${id}`)).toBeVisible()
  })

  test("plain .slide decks (no data-dock-slide) resolve by document order", async ({ owner }) => {
    // Fallback path: a deck that uses only `.slide`, no explicit index attribute.
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>D</title>
<style>.slide{display:none}.slide.on{display:block}</style></head><body><main>
<section class="slide on"><p>One alpha.</p></section>
<section class="slide"><p>Two beta unique.</p></section>
<section class="slide"><p>Three gamma.</p></section>
</main><script>(function(){var s=[].slice.call(document.querySelectorAll('.slide')),i=0;
function r(){try{parent.postMessage({source:'dock-deck',type:'state',i:i,total:s.length},'*')}catch(e){}}
function show(n){i=Math.max(0,Math.min(s.length-1,n));s.forEach(function(x,k){x.classList.toggle('on',k===i)});r()}
window.addEventListener('message',function(e){var d=e.data;if(!d||d.source!=='dock-host'||d.type!=='deck')return;
if(d.action==='next')show(i+1);else if(d.action==='prev')show(i-1);else if(d.action==='goto')show(d.n)});show(0);r()})();</script></body></html>`
    const shortId = await publishDeck(owner, html)
    const id = await anchorComment(owner, shortId, "doc-order", "Two beta unique", 1)
    await owner.goto(`/a/${shortId}`)
    await expect(owner.getByTestId(`comment-slide-${id}`)).toHaveText("Slide 2")
  })
})

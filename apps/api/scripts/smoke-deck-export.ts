import { execFile } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { unzipSync } from "fflate"
import { imageBackedPptx } from "../src/lib/export-system"
import { playwrightRenderer } from "../src/preview-node"

const fixture = (slideCount: number): string => `<!doctype html>
<html data-derive-export-ready="true"><head><meta charset="utf-8"><style>
html,body{height:100%;margin:0;overflow:hidden}.stage{position:fixed;left:50%;top:50%;width:1280px;height:720px;transform:translate(-50%,-50%);overflow:hidden}
.slide{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:0;font:700 72px system-ui;color:white}
.slide:first-child{opacity:1}.chrome{position:absolute;right:20px;bottom:20px}
</style></head><body><main class="stage">
${Array.from(
  { length: slideCount },
  (_, index) =>
    `<section class="slide" data-derive-slide="${index}" style="background:hsl(${index * 70} 65% 38%)">Slide ${index + 1}</section>`,
).join("\n")}
<span class="chrome count">${slideCount} / ${slideCount}</span>
</main><button class="zone">Next</button><div class="rail"></div></body></html>`

const asDataUrl = (html: string): string =>
  `data:text/html;charset=utf-8,${encodeURIComponent(html)}`

const run = promisify(execFile)
const assertPdf = async (path: string, expectedPages: number): Promise<void> => {
  const { stdout } = await run("pdfinfo", [path])
  const pageCount = Number.parseInt(stdout.match(/^Pages:\s+(\d+)$/m)?.[1] ?? "", 10)
  if (pageCount !== expectedPages)
    throw new Error(`expected ${expectedPages} PDF pages, got ${pageCount}`)
  if (!/^Page size:\s+960 x 540 pts/m.test(stdout))
    throw new Error("expected every deck PDF page to be 960x540pt (16:9)")
}

const renderer = playwrightRenderer()
if (!renderer.pdf || !renderer.deckImages) throw new Error("deck renderer is unavailable")
const outputDir = await mkdtemp(join(tmpdir(), "derive-deck-export-"))

for (const slideCount of [1, 2, 4]) {
  const pdf = await renderer.pdf(asDataUrl(fixture(slideCount)), {
    timeoutMs: 20_000,
    deck: true,
  })
  const pdfPath = join(outputDir, `${slideCount}-slide-deck.pdf`)
  await writeFile(pdfPath, pdf)
  await assertPdf(pdfPath, slideCount)
}

const images = await renderer.deckImages(asDataUrl(fixture(4)), 20_000)
if (images.length !== 4) throw new Error(`expected 4 rendered slide images, got ${images.length}`)
const pptx = imageBackedPptx(images, "four-slide export smoke")
const packageFiles = Object.keys(unzipSync(pptx))
const slideXmlCount = packageFiles.filter((name) =>
  /^ppt\/slides\/slide\d+\.xml$/.test(name),
).length
const mediaCount = packageFiles.filter((name) => /^ppt\/media\/image\d+\.png$/.test(name)).length
if (slideXmlCount !== 4 || mediaCount !== 4)
  throw new Error(`expected 4 PPTX slides/media, got ${slideXmlCount}/${mediaCount}`)
await writeFile(join(outputDir, "four-slide-deck.pptx"), pptx)

console.log(`deck export smoke passed: 1/2/4 slides => 1/2/4 PDF pages; output ${outputDir}`)

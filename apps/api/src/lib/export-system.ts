import { escapeHtml, sha256Hex } from "@derive/core"
import { strToU8, zipSync } from "fflate"

export const EXPORT_KINDS = [
  "page_pdf",
  "chart_png",
  "chart_json",
  "chart_csv",
  "email",
  "deck_pdf",
  "deck_pptx",
] as const
export type ExportKind = (typeof EXPORT_KINDS)[number]

export interface ExportOptions {
  region?: string
  dataSlot?: string
  publicImage?: boolean
  recipient?: string
  note?: string
  attachPdf?: boolean
  title?: string
  /** Internal-only PR-preview guard. Never accepted from the public request schema. */
  qaCapture?: boolean
}

export const profileFor = (kind: ExportKind): string =>
  ({
    page_pdf: "page-pdf",
    chart_png: "chart",
    chart_json: "data-json",
    chart_csv: "data-csv",
    email: "email-hero",
    deck_pdf: "deck-pdf",
    deck_pptx: "deck-pptx",
  })[kind]

export const normalizeExportOptions = (input: ExportOptions): ExportOptions => ({
  ...(input.region?.trim() ? { region: input.region.trim().slice(0, 200) } : {}),
  ...(input.dataSlot?.trim() ? { dataSlot: input.dataSlot.trim().slice(0, 120) } : {}),
  ...(input.publicImage !== undefined ? { publicImage: input.publicImage } : {}),
  ...(input.recipient?.trim()
    ? { recipient: input.recipient.trim().toLowerCase().slice(0, 320) }
    : {}),
  ...(input.note?.trim() ? { note: input.note.trim().slice(0, 2_000) } : {}),
  ...(input.attachPdf !== undefined ? { attachPdf: input.attachPdf } : {}),
  ...(input.title?.trim() ? { title: input.title.trim().slice(0, 240) } : {}),
  ...(input.qaCapture === true ? { qaCapture: true } : {}),
})

/** RFC-reserved test TLD. A preview capture can never address a deliverable mailbox. */
export const isQaEmailRecipient = (value: string): boolean => {
  const domain = value.trim().toLowerCase().split("@").at(-1)
  return !!domain && domain.endsWith(".test")
}

export const exportInputHash = async (input: {
  artifactId: string
  version: number
  requestedBy: string
  rendererScope: string
  kind: ExportKind
  options: ExportOptions
}): Promise<string> =>
  sha256Hex(
    new TextEncoder().encode(
      JSON.stringify([
        input.artifactId,
        input.version,
        input.requestedBy,
        input.rendererScope,
        input.kind,
        normalizeExportOptions(input.options),
      ]),
    ),
  )

export const csvFromJson = (value: unknown): string => {
  const rows = Array.isArray(value) ? value : [value]
  if (!rows.every((row) => row !== null && typeof row === "object" && !Array.isArray(row)))
    throw new Error("CSV export requires a declared tabular fact (an array of objects)")
  const records = rows as Record<string, unknown>[]
  const headers = [...new Set(records.flatMap((row) => Object.keys(row)))]
  if (!headers.length) throw new Error("CSV export requires at least one declared column")
  const cell = (value: unknown): string => {
    const raw =
      value === null || value === undefined
        ? ""
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value)
    return /[",\r\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw
  }
  return [
    headers.map(cell).join(","),
    ...records.map((row) => headers.map((h) => cell(row[h])).join(",")),
  ].join("\r\n")
}

export const buildExportEmail = (input: {
  to: string
  title: string
  note?: string
  openUrl: string
  imageUrl: string
  alt: string
  version: number
}) => {
  const title = escapeHtml(input.title)
  const note = input.note
    ? `<p style="margin:0 0 20px;color:#333">${escapeHtml(input.note)}</p>`
    : ""
  const image = `<img src="${escapeHtml(input.imageUrl)}" width="600" alt="${escapeHtml(input.alt)}" style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:10px;background:#f2f2f2"/>`
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f5;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#181818"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#fff;border-radius:14px"><tr><td style="padding:28px"><p style="margin:0 0 6px;font-size:20px;font-weight:650">${title}</p><p style="margin:0 0 20px;color:#777;font-size:13px">Derive · version ${input.version}</p>${note}${image}<p style="margin:24px 0 0"><a href="${escapeHtml(input.openUrl)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#181818;color:#fff;text-decoration:none;font-weight:600">Open in Derive</a></p><p style="margin:18px 0 0;color:#777;font-size:12px">This static copy does not change access to the original.</p></td></tr></table></td></tr></table></body></html>`
  const text = [
    input.title,
    `Derive version ${input.version}`,
    input.note ?? "",
    `Open: ${input.openUrl}`,
  ]
    .filter(Boolean)
    .join("\n\n")
  return { to: input.to, subject: `${input.title} · Derive`, html, text }
}

const base64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Private, browser-renderable evidence for PR previews. This is deliberately an
 * artifact capture, not an email transport: CID content is embedded as a data URL,
 * attachments are inventoried, and no row ever enters the notification outbox. */
export const buildQaEmailCapture = (input: {
  message: ReturnType<typeof buildExportEmail>
  cidImage?: Uint8Array
  attachments: Array<{ filename: string; contentType: string }>
}): Uint8Array => {
  const html = input.cidImage
    ? input.message.html.replaceAll(
        "cid:derive-export",
        `data:image/png;base64,${base64(input.cidImage)}`,
      )
    : input.message.html
  const attachmentRows = input.attachments.length
    ? input.attachments
        .map(
          (item) =>
            `<li><strong>${escapeHtml(item.filename)}</strong> · ${escapeHtml(item.contentType)}</li>`,
        )
        .join("")
    : "<li>None (hosted image mode)</li>"
  const capture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Derive QA email capture</title></head><body style="margin:0;background:#e9e9e9;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#181818"><section style="padding:16px 20px;background:#fff4cc;border-bottom:1px solid #e2cf7a"><strong>QA capture · no email was sent</strong><div style="margin-top:6px;font-size:13px">To: ${escapeHtml(input.message.to)} · Subject: ${escapeHtml(input.message.subject)}</div><details style="margin-top:8px"><summary>Plain-text alternative</summary><pre style="white-space:pre-wrap">${escapeHtml(input.message.text)}</pre></details><details><summary>Attachment manifest</summary><ul>${attachmentRows}</ul></details></section>${html}</body></html>`
  return new TextEncoder().encode(capture)
}

const xml = (value: string): string => escapeHtml(value).replaceAll("'", "&apos;")

/** Fidelity-first PPTX: each 16:9 slide is one full-bleed PNG. The package carries
 * immutable Derive provenance in core properties and makes no editability claim. */
export const imageBackedPptx = (images: Uint8Array[], provenance: string): Uint8Array => {
  if (!images.length) throw new Error("deck has no slides")
  const files: Record<string, Uint8Array> = {}
  const put = (path: string, body: string | Uint8Array) => {
    files[path] = typeof body === "string" ? strToU8(body) : body
  }
  const slideOverrides = images
    .map(
      (_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join("")
  put(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${slideOverrides}</Types>`,
  )
  put(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
  )
  put(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Derive image-backed export</dc:title><dc:description>${xml(provenance)}</dc:description></cp:coreProperties>`,
  )
  put(
    "docProps/app.xml",
    `<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Derive</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat><Slides>${images.length}</Slides><Company>Derive</Company><AppVersion>1.0</AppVersion></Properties>`,
  )
  const slideIds = images.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")
  put(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  )
  put(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${images.map((_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`,
  )
  put(
    "ppt/slideMasters/slideMaster1.xml",
    `<?xml version="1.0" encoding="UTF-8"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Derive Master"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm/></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`,
  )
  put(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`,
  )
  put(
    "ppt/slideLayouts/slideLayout1.xml",
    `<?xml version="1.0" encoding="UTF-8"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm/></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
  )
  put(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
  )
  put(
    "ppt/theme/theme1.xml",
    `<?xml version="1.0" encoding="UTF-8"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Derive"><a:themeElements><a:clrScheme name="Derive"><a:dk1><a:srgbClr val="181818"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="343434"/></a:dk2><a:lt2><a:srgbClr val="F4F4F4"/></a:lt2><a:accent1><a:srgbClr val="7057FF"/></a:accent1><a:accent2><a:srgbClr val="146EF5"/></a:accent2><a:accent3><a:srgbClr val="00A67E"/></a:accent3><a:accent4><a:srgbClr val="F59E0B"/></a:accent4><a:accent5><a:srgbClr val="DB2777"/></a:accent5><a:accent6><a:srgbClr val="7C3AED"/></a:accent6><a:hlink><a:srgbClr val="146EF5"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme><a:fontScheme name="Derive"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Derive"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
  )
  images.forEach((image, i) => {
    const n = i + 1
    put(`ppt/media/image${n}.png`, image)
    put(
      `ppt/slides/slide${n}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:pic><p:nvPicPr><p:cNvPr id="2" name="Derive slide ${n}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    )
    put(
      `ppt/slides/_rels/slide${n}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${n}.png"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
    )
  })
  return zipSync(files, { level: 6 })
}

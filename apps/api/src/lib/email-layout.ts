import { escapeHtml } from "@derive/core"
import type { ExportEmailMessage } from "./export-system"

export const EMAIL_LAYOUT_FACT = "email-layout"

const MAX_BLOCKS = 16
const MAX_ITEMS = 12

type EmailTone = "neutral" | "positive" | "warning" | "critical"

type EmailBlock =
  | { type: "paragraph"; body: string }
  | { type: "kpis"; items: Array<{ label: string; value: string; delta?: string }> }
  | {
      type: "bars"
      title?: string
      max?: number
      items: Array<{ label: string; value: number; display?: string; color?: string }>
    }
  | {
      type: "segments"
      title?: string
      items: Array<{ label: string; value: number; display?: string; color?: string }>
    }
  | {
      type: "funnel"
      title?: string
      items: Array<{ label: string; value: number; display?: string; color?: string }>
    }
  | { type: "table"; title?: string; columns: string[]; rows: string[][] }
  | { type: "callout"; tone: EmailTone; title?: string; body: string }
  | { type: "button"; label: string; url: string }
  | { type: "divider" }

export interface EmailLayout {
  schema: "derive.email/v1"
  preheader?: string
  title: string
  subtitle?: string
  blocks: EmailBlock[]
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const string = (
  value: unknown,
  label: string,
  max = 2_000,
  required = false,
): string | undefined => {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} is required`)
    return undefined
  }
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  if (required && !trimmed) throw new Error(`${label} is required`)
  if (trimmed.length > max) throw new Error(`${label} exceeds ${max} characters`)
  return trimmed || undefined
}

const number = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${label} must be a finite number`)
  return value
}

const color = (value: unknown, label: string): string | undefined => {
  const parsed = string(value, label, 7)
  if (parsed && !/^#[0-9a-f]{6}$/i.test(parsed)) throw new Error(`${label} must be a hex color`)
  return parsed
}

const tone = (value: unknown): EmailTone => {
  if (value === undefined) return "neutral"
  if (["neutral", "positive", "warning", "critical"].includes(String(value)))
    return value as EmailTone
  throw new Error("callout tone is invalid")
}

const array = (value: unknown, label: string, max = MAX_ITEMS): unknown[] => {
  if (!Array.isArray(value) || !value.length) throw new Error(`${label} must be a non-empty array`)
  if (value.length > max) throw new Error(`${label} exceeds ${max} items`)
  return value
}

const chartItems = (
  value: unknown,
  label: string,
): Array<{ label: string; value: number; display?: string; color?: string }> =>
  array(value, label).map((raw, index) => {
    const item = record(raw)
    if (!item) throw new Error(`${label}[${index}] must be an object`)
    return {
      label: string(item.label, `${label}[${index}].label`, 120, true) as string,
      value: number(item.value, `${label}[${index}].value`),
      ...(string(item.display, `${label}[${index}].display`, 80)
        ? { display: string(item.display, `${label}[${index}].display`, 80) }
        : {}),
      ...(color(item.color, `${label}[${index}].color`)
        ? { color: color(item.color, `${label}[${index}].color`) }
        : {}),
    }
  })

const parseBlock = (raw: unknown, index: number): EmailBlock => {
  const block = record(raw)
  if (!block || typeof block.type !== "string") throw new Error(`blocks[${index}] is invalid`)
  const label = `blocks[${index}]`
  if (block.type === "paragraph")
    return { type: "paragraph", body: string(block.body, `${label}.body`, 4_000, true) as string }
  if (block.type === "kpis") {
    const items = array(block.items, `${label}.items`, 9).map((rawItem, itemIndex) => {
      const item = record(rawItem)
      if (!item) throw new Error(`${label}.items[${itemIndex}] must be an object`)
      return {
        label: string(item.label, `${label}.items[${itemIndex}].label`, 80, true) as string,
        value: string(item.value, `${label}.items[${itemIndex}].value`, 80, true) as string,
        ...(string(item.delta, `${label}.items[${itemIndex}].delta`, 80)
          ? { delta: string(item.delta, `${label}.items[${itemIndex}].delta`, 80) }
          : {}),
      }
    })
    return { type: "kpis", items }
  }
  if (block.type === "bars" || block.type === "segments" || block.type === "funnel") {
    const common = {
      title: string(block.title, `${label}.title`, 160),
      items: chartItems(block.items, `${label}.items`),
    }
    if (block.type === "bars")
      return {
        type: "bars",
        ...(common.title ? { title: common.title } : {}),
        items: common.items,
        ...(block.max === undefined ? {} : { max: number(block.max, `${label}.max`) }),
      }
    return {
      type: block.type,
      ...(common.title ? { title: common.title } : {}),
      items: common.items,
    }
  }
  if (block.type === "table") {
    const columns = array(block.columns, `${label}.columns`, 6).map(
      (value, column) => string(value, `${label}.columns[${column}]`, 120, true) as string,
    )
    const rows = array(block.rows, `${label}.rows`, 20).map((rawRow, rowIndex) => {
      if (!Array.isArray(rawRow) || rawRow.length !== columns.length)
        throw new Error(`${label}.rows[${rowIndex}] must match the column count`)
      return rawRow.map(
        (value, column) =>
          string(String(value ?? ""), `${label}.rows[${rowIndex}][${column}]`, 500) ?? "",
      )
    })
    const title = string(block.title, `${label}.title`, 160)
    return { type: "table", ...(title ? { title } : {}), columns, rows }
  }
  if (block.type === "callout") {
    const title = string(block.title, `${label}.title`, 160)
    return {
      type: "callout",
      tone: tone(block.tone),
      ...(title ? { title } : {}),
      body: string(block.body, `${label}.body`, 2_000, true) as string,
    }
  }
  if (block.type === "button") {
    const url = string(block.url, `${label}.url`, 2_000, true) as string
    if (!/^https:\/\//i.test(url)) throw new Error(`${label}.url must use https`)
    return {
      type: "button",
      label: string(block.label, `${label}.label`, 80, true) as string,
      url,
    }
  }
  if (block.type === "divider") return { type: "divider" }
  throw new Error(`${label}.type is unsupported`)
}

/** Missing or unrelated facts return null. A declared v1 layout is validated strictly so
 * preview catches authoring mistakes instead of silently switching representation. */
export const parseEmailLayout = (value: unknown): EmailLayout | null => {
  const layout = record(value)
  if (layout?.schema !== "derive.email/v1") return null
  return {
    schema: "derive.email/v1",
    preheader: string(layout.preheader, "preheader", 200),
    title: string(layout.title, "title", 240, true) as string,
    subtitle: string(layout.subtitle, "subtitle", 500),
    blocks: array(layout.blocks, "blocks", MAX_BLOCKS).map(parseBlock),
  }
}

const esc = (value: string): string => escapeHtml(value)
const richText = (value: string): string => esc(value).replaceAll("\n", "<br>")
const sectionTitle = (value?: string): string =>
  value
    ? `<h2 style="margin:0 0 14px;font-size:18px;line-height:1.3;color:#17201d">${esc(value)}</h2>`
    : ""
const palette = ["#155f52", "#4f46e5", "#c77700", "#b42318", "#6d28d9", "#087f8c"]

const renderKpis = (block: Extract<EmailBlock, { type: "kpis" }>): string => {
  const rows = Array.from({ length: Math.ceil(block.items.length / 3) }, (_, row) =>
    block.items.slice(row * 3, row * 3 + 3),
  )
  return rows
    .map(
      (items) =>
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px"><tr>${items
          .map(
            (item) =>
              `<td width="33.33%" valign="top" style="padding:0 5px"><div style="border:1px solid #d9ddd7;border-radius:12px;padding:15px;background:#f8faf7"><div style="font-size:11px;line-height:1.3;text-transform:uppercase;letter-spacing:.08em;color:#66706b">${esc(item.label)}</div><div style="margin-top:7px;font-size:24px;line-height:1.1;font-weight:750;color:#17201d">${esc(item.value)}</div>${item.delta ? `<div style="margin-top:6px;font-size:12px;color:#155f52">${esc(item.delta)}</div>` : ""}</div></td>`,
          )
          .join("")}</tr></table>`,
    )
    .join("")
}

const renderBars = (block: Extract<EmailBlock, { type: "bars" }>): string => {
  const max = Math.max(
    Math.abs(block.max ?? 0),
    ...block.items.map((item) => Math.abs(item.value)),
    1,
  )
  const rows = block.items
    .map((item, index) => {
      const width = Math.max(2, Math.min(100, (Math.abs(item.value) / max) * 100))
      const fill = item.color ?? (item.value < 0 ? "#b42318" : palette[index % palette.length])
      return `<tr><td width="30%" valign="middle" style="padding:7px 10px 7px 0;font-size:12px;color:#35403c">${esc(item.label)}</td><td width="52%" valign="middle" style="padding:7px 8px 7px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e9ece8;border-radius:999px"><tr><td width="${width}%" height="12" style="width:${width}%;height:12px;background:${fill};border-radius:999px;font-size:0">&nbsp;</td><td></td></tr></table></td><td width="18%" align="right" style="padding:7px 0;font-size:12px;font-weight:700;color:#17201d">${esc(item.display ?? String(item.value))}</td></tr>`
    })
    .join("")
  return `${sectionTitle(block.title)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`
}

const renderSegments = (block: Extract<EmailBlock, { type: "segments" }>): string => {
  const total = block.items.reduce((sum, item) => sum + Math.max(0, item.value), 0) || 1
  const cells = block.items
    .map((item, index) => {
      const width = Math.max(3, (Math.max(0, item.value) / total) * 100)
      return `<td width="${width}%" height="24" style="width:${width}%;height:24px;background:${item.color ?? palette[index % palette.length]};font-size:0">&nbsp;</td>`
    })
    .join("")
  const legend = block.items
    .map(
      (item, index) =>
        `<tr><td width="18" style="padding:5px 0"><span style="display:block;width:10px;height:10px;border-radius:3px;background:${item.color ?? palette[index % palette.length]}">&nbsp;</span></td><td style="padding:5px 4px;font-size:12px;color:#35403c">${esc(item.label)}</td><td align="right" style="padding:5px 0;font-size:12px;font-weight:700;color:#17201d">${esc(item.display ?? String(item.value))}</td></tr>`,
    )
    .join("")
  return `${sectionTitle(block.title)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:8px;overflow:hidden"><tr>${cells}</tr></table><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px">${legend}</table>`
}

const renderFunnel = (block: Extract<EmailBlock, { type: "funnel" }>): string => {
  const max = Math.max(...block.items.map((item) => Math.abs(item.value)), 1)
  const rows = block.items
    .map((item, index) => {
      const width = Math.max(26, Math.min(100, (Math.abs(item.value) / max) * 100))
      return `<tr><td align="center" style="padding:4px 0"><table role="presentation" width="${width}%" cellpadding="0" cellspacing="0" style="width:${width}%;background:${item.color ?? palette[index % palette.length]};border-radius:8px"><tr><td align="center" style="padding:10px 8px;color:#fff;font-size:12px"><strong>${esc(item.label)}</strong>&nbsp;&nbsp;${esc(item.display ?? String(item.value))}</td></tr></table></td></tr>`
    })
    .join("")
  return `${sectionTitle(block.title)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`
}

const renderTable = (block: Extract<EmailBlock, { type: "table" }>): string => {
  const head = block.columns
    .map(
      (column) =>
        `<th align="left" style="padding:9px 8px;border-bottom:1px solid #cfd5d1;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#66706b">${esc(column)}</th>`,
    )
    .join("")
  const rows = block.rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td valign="top" style="padding:10px 8px;border-bottom:1px solid #e6e9e6;font-size:12px;line-height:1.4;color:#26302c">${richText(cell)}</td>`).join("")}</tr>`,
    )
    .join("")
  return `${sectionTitle(block.title)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;border:1px solid #d9ddd7;border-radius:10px"> <tr>${head}</tr>${rows}</table>`
}

const renderCallout = (block: Extract<EmailBlock, { type: "callout" }>): string => {
  const colors: Record<EmailTone, [string, string]> = {
    neutral: ["#edf2ef", "#35403c"],
    positive: ["#e8f8ee", "#126c3d"],
    warning: ["#fff4d6", "#7a5300"],
    critical: ["#fdecea", "#9d2018"],
  }
  const [background, foreground] = colors[block.tone]
  return `<div style="padding:16px 18px;border-radius:12px;background:${background};color:${foreground}">${block.title ? `<div style="font-weight:750;margin-bottom:5px">${esc(block.title)}</div>` : ""}<div style="font-size:13px;line-height:1.55">${richText(block.body)}</div></div>`
}

const renderBlock = (block: EmailBlock): string => {
  let body = ""
  if (block.type === "paragraph")
    body = `<p style="margin:0;font-size:14px;line-height:1.65;color:#35403c">${richText(block.body)}</p>`
  else if (block.type === "kpis") body = renderKpis(block)
  else if (block.type === "bars") body = renderBars(block)
  else if (block.type === "segments") body = renderSegments(block)
  else if (block.type === "funnel") body = renderFunnel(block)
  else if (block.type === "table") body = renderTable(block)
  else if (block.type === "callout") body = renderCallout(block)
  else if (block.type === "button")
    body = `<a href="${esc(block.url)}" style="display:inline-block;padding:11px 16px;border-radius:9px;background:#155f52;color:#fff;text-decoration:none;font-weight:700;font-size:13px">${esc(block.label)}</a>`
  else body = '<div style="height:1px;background:#e2e6e3;font-size:0">&nbsp;</div>'
  return `<tr><td style="padding:0 28px 22px">${body}</td></tr>`
}

const blockText = (block: EmailBlock): string => {
  if (block.type === "paragraph") return block.body
  if (block.type === "kpis")
    return block.items
      .map((item) => `${item.label}: ${item.value}${item.delta ? ` (${item.delta})` : ""}`)
      .join("\n")
  if (block.type === "bars" || block.type === "segments" || block.type === "funnel")
    return [
      block.title,
      ...block.items.map((item) => `${item.label}: ${item.display ?? item.value}`),
    ]
      .filter(Boolean)
      .join("\n")
  if (block.type === "table")
    return [block.title, block.columns.join(" | "), ...block.rows.map((row) => row.join(" | "))]
      .filter(Boolean)
      .join("\n")
  if (block.type === "callout") return [block.title, block.body].filter(Boolean).join(": ")
  if (block.type === "button") return `${block.label}: ${block.url}`
  return ""
}

export const buildRichExportEmail = (input: {
  to: string
  subjectTitle: string
  note?: string
  openUrl: string
  version: number
  layout: EmailLayout
}): ExportEmailMessage => {
  const subject = input.subjectTitle.replace(/[\r\n]+/g, " ").trim()
  const preheader = input.layout.preheader ?? input.layout.subtitle ?? input.layout.title
  const note = input.note
    ? `<tr><td style="padding:0 28px 22px"><div style="padding:13px 15px;border-left:3px solid #c9f77b;background:#f5f8f3;color:#35403c;font-size:13px;line-height:1.5">${richText(input.note)}</div></td></tr>`
    : ""
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>@media(max-width:620px){.derive-shell{border-radius:0!important}.derive-pad{padding-left:18px!important;padding-right:18px!important}}</style></head><body style="margin:0;background:#eef1ee;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;color:#17201d"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 10px"><table role="presentation" width="620" cellpadding="0" cellspacing="0" class="derive-shell" style="width:100%;max-width:620px;background:#fff;border:1px solid #d9ddd7;border-radius:16px;overflow:hidden"><tr><td class="derive-pad" style="padding:26px 28px 9px"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.12em;font-weight:800;color:#155f52">Derive · version ${input.version}</div><h1 style="margin:10px 0 0;font-size:28px;line-height:1.1;letter-spacing:-.03em;color:#17201d">${esc(input.layout.title)}</h1>${input.layout.subtitle ? `<p style="margin:9px 0 0;font-size:14px;line-height:1.55;color:#66706b">${richText(input.layout.subtitle)}</p>` : ""}</td></tr><tr><td style="padding:0 28px 20px"><div style="height:1px;background:#e2e6e3;font-size:0">&nbsp;</div></td></tr>${note}${input.layout.blocks.map(renderBlock).join("")}<tr><td class="derive-pad" style="padding:4px 28px 28px"><a href="${esc(input.openUrl)}" style="display:inline-block;padding:11px 16px;border-radius:9px;background:#17201d;color:#fff;text-decoration:none;font-weight:700;font-size:13px">Open in Derive</a><p style="margin:16px 0 0;color:#7b847f;font-size:11px;line-height:1.5">This email-safe rendering is pinned to version ${input.version}. It does not change access to the original.</p></td></tr></table></td></tr></table></body></html>`
  const text = [
    input.layout.title,
    input.layout.subtitle,
    `Derive version ${input.version}`,
    input.note,
    ...input.layout.blocks.map(blockText),
    `Open: ${input.openUrl}`,
  ]
    .filter(Boolean)
    .join("\n\n")
  return { to: input.to, subject: `${subject} · Derive`, html, text }
}

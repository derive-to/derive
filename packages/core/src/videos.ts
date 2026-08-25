import { EditError } from "./doc-text"
import { attrValue, attrValues, elementEnd, type HtmlTag, tags } from "./html-tags"

export const VIDEO_CONTENT_TYPE = "text/x-derive-video"
const SCENE_TAGS = new Set(["section", "div", "article"])
const TRANSITIONS = new Set(["cut", "fade", "dissolve", "slide"])
const SCENE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

export interface VideoScene {
  position: number
  start: number
  end: number
  openStart: number
  openEnd: number
  id: string
  durationMs: number
  transition: string
  transitionMs: number
  title?: string
  caption?: string
}

export type SceneEdit =
  | {
      op: "scene-update"
      id: string
      duration_ms?: number
      transition?: "cut" | "fade" | "dissolve" | "slide"
      transition_ms?: number
      caption?: string
    }
  | { op: "scene-move"; id: string; direction: "previous" | "next" }
  | { op: "scene-duplicate"; id: string }
  | { op: "scene-delete"; id: string }

export const isSceneEdit = (value: unknown): value is SceneEdit =>
  !!value &&
  typeof value === "object" &&
  typeof (value as { op?: unknown }).op === "string" &&
  String((value as { op?: unknown }).op).startsWith("scene-")

export const sliceScenes = (html: string): VideoScene[] => {
  const all = tags(html)
  const roots = all
    .map((tag, i) => ({ tag, i }))
    .filter(({ tag }) => !tag.closing && /\bdata-derive-video(?:\s|=|$)/i.test(tag.attrs))
  if (roots.length !== 1)
    throw new EditError("An HTML video needs exactly one data-derive-video root.")
  const root = roots[0] as { tag: HtmlTag; i: number }
  const rootEnd = elementEnd(all, root.i)
  if (rootEnd < 0) throw new EditError("The data-derive-video root is never closed.")
  const spans: VideoScene[] = []
  for (let i = 0; i < all.length; i++) {
    const open = all[i] as HtmlTag
    if (open.closing || !SCENE_TAGS.has(open.name)) continue
    if (open.start <= root.tag.start || open.start >= rootEnd) continue
    const sceneIds = attrValues(open.attrs, "data-derive-scene")
    if (sceneIds.length > 1)
      throw new EditError(
        "A video scene has more than one data-derive-scene attribute, so its identity is ambiguous.",
      )
    const id = sceneIds[0] ?? null
    if (!id) continue
    if (!SCENE_ID.test(id))
      throw new EditError(
        `Scene "${id}" needs a short stable id beginning with a letter and using only letters, numbers, - or _.`,
      )
    const end = elementEnd(all, i)
    if (end < 0)
      throw new EditError(`Scene "${id}" is never closed, so the video cannot be edited safely.`)
    const durationRaw = attrValue(open.attrs, "data-duration-ms")
    const transitionRaw = attrValue(open.attrs, "data-transition")
    const transitionMsRaw = attrValue(open.attrs, "data-transition-ms")
    const durationMs = durationRaw == null ? 5000 : Number(durationRaw)
    const transition = transitionRaw || "cut"
    const transitionMs = transitionMsRaw == null ? 300 : Number(transitionMsRaw)
    if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 30000)
      throw new EditError(`Scene "${id}" duration must be a whole number from 1000 to 30000 ms.`)
    if (!TRANSITIONS.has(transition))
      throw new EditError(`Scene "${id}" has unknown transition "${transition}".`)
    if (!Number.isInteger(transitionMs) || transitionMs < 100 || transitionMs > 2000)
      throw new EditError(`Scene "${id}" transition duration must be 100 to 2000 ms.`)
    const source = html.slice(open.start, end)
    const heading = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(source)?.[1]
    const title =
      attrValue(open.attrs, "data-derive-scene-title") ||
      heading
        ?.replace(/<[^<>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    const caption = attrValue(open.attrs, "data-derive-caption")
    spans.push({
      position: 0,
      start: open.start,
      end,
      openStart: open.start,
      openEnd: open.end,
      id,
      durationMs,
      transition,
      transitionMs,
      ...(title ? { title } : {}),
      ...(caption ? { caption } : {}),
    })
  }
  for (let i = 1; i < spans.length; i++)
    if ((spans[i] as VideoScene).start < (spans[i - 1] as VideoScene).end)
      throw new EditError("A video scene is nested inside another scene. Edit the source directly.")
  const ids = spans.map((s) => s.id)
  if (new Set(ids).size !== ids.length)
    throw new EditError("Every video scene needs a unique data-derive-scene value.")
  return spans.map((s, i) => ({ ...s, position: i + 1 }))
}

export const isVideoDocument = (html: string): boolean => {
  if (!/data-derive-video(?:\s|=|>)/i.test(html)) return false
  try {
    return sliceScenes(html).length > 0
  } catch {
    return false
  }
}

const boundedInteger = (value: unknown, min: number, max: number, label: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new EditError(`${label} must be a whole number between ${min} and ${max}.`)
  return value
}

const setAttr = (tag: string, name: string, value: string): string => {
  const escaped = value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
  const re = new RegExp(`(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i")
  const found = re.exec(tag)
  if (found)
    return `${tag.slice(0, found.index)}${found[1]}"${escaped}"${tag.slice(found.index + found[0].length)}`
  const close = tag.lastIndexOf(">")
  return close < 0 ? tag : `${tag.slice(0, close)} ${name}="${escaped}"${tag.slice(close)}`
}

const freshId = (scenes: VideoScene[]): string => {
  const used = new Set(scenes.map((s) => s.id))
  let n = scenes.length + 1
  while (used.has(`scene-${n}`)) n++
  return `scene-${n}`
}

export const applySceneEdits = (html: string, edits: SceneEdit[]): string => {
  if (!Array.isArray(edits) || edits.length === 0)
    throw new EditError("`edits` contains no scene operations.")
  if (edits.length > 200)
    throw new EditError("A video edit can contain at most 200 scene operations.")
  let out = html
  for (const raw of edits) {
    const scenes = sliceScenes(out)
    const at = scenes.findIndex((s) => s.id === raw.id)
    if (at < 0) throw new EditError(`Scene "${raw.id}" no longer exists.`)
    const scene = scenes[at] as VideoScene
    if (raw.op === "scene-update") {
      let opening = out.slice(scene.openStart, scene.openEnd)
      if (raw.duration_ms !== undefined)
        opening = setAttr(
          opening,
          "data-duration-ms",
          String(boundedInteger(raw.duration_ms, 1000, 30000, "Scene duration")),
        )
      if (raw.transition !== undefined) {
        if (!TRANSITIONS.has(raw.transition))
          throw new EditError(`Unknown scene transition "${raw.transition}".`)
        opening = setAttr(opening, "data-transition", raw.transition)
      }
      if (raw.transition_ms !== undefined)
        opening = setAttr(
          opening,
          "data-transition-ms",
          String(boundedInteger(raw.transition_ms, 100, 2000, "Transition duration")),
        )
      if (raw.caption !== undefined) {
        if (typeof raw.caption !== "string" || raw.caption.length > 500)
          throw new EditError("Scene caption must be at most 500 characters.")
        opening = setAttr(opening, "data-derive-caption", raw.caption)
      }
      out = out.slice(0, scene.openStart) + opening + out.slice(scene.openEnd)
    } else if (raw.op === "scene-delete") {
      if (scenes.length === 1) throw new EditError("A video must keep at least one scene.")
      out = out.slice(0, scene.start) + out.slice(scene.end)
    } else if (raw.op === "scene-duplicate") {
      const copy = setAttr(out.slice(scene.start, scene.end), "data-derive-scene", freshId(scenes))
      out = `${out.slice(0, scene.end)}\n${copy}${out.slice(scene.end)}`
    } else if (raw.op === "scene-move") {
      if (raw.direction !== "previous" && raw.direction !== "next")
        throw new EditError(
          `Scene move direction ${JSON.stringify(raw.direction)} is invalid — use "previous" or "next".`,
        )
      const to = raw.direction === "previous" ? at - 1 : at + 1
      if (to < 0 || to >= scenes.length) continue
      const other = scenes[to] as VideoScene
      const first = raw.direction === "previous" ? other : scene
      const second = raw.direction === "previous" ? scene : other
      const between = out.slice(first.end, second.start)
      if (between.trim()) throw new EditError("Content between scenes prevents a safe reorder.")
      const a = out.slice(first.start, first.end)
      const b = out.slice(second.start, second.end)
      out = out.slice(0, first.start) + b + between + a + out.slice(second.end)
    } else
      throw new EditError(
        `Unknown scene operation ${JSON.stringify((raw as { op?: unknown }).op)}.`,
      )
  }
  if (out === html)
    throw new EditError("Those scene edits leave the video exactly as it is; nothing to publish.")
  return out
}

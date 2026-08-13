import { EditError } from "./doc-text"
import { attrValue, elementEnd, type HtmlTag, tags } from "./html-tags"

export const VIDEO_CONTENT_TYPE = "text/x-derive-video"
const SCENE_TAGS = new Set(["section", "div", "article"])
const TRANSITIONS = new Set(["cut", "fade", "dissolve", "slide"])

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
}

export type SceneEdit =
  | {
      op: "scene-update"
      id: string
      duration_ms?: number
      transition?: "cut" | "fade" | "dissolve" | "slide"
      transition_ms?: number
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
  const spans: VideoScene[] = []
  for (let i = 0; i < all.length; i++) {
    const open = all[i] as HtmlTag
    if (open.closing || !SCENE_TAGS.has(open.name)) continue
    const id = attrValue(open.attrs, "data-derive-scene")
    if (!id) continue
    const end = elementEnd(all, i)
    if (end < 0)
      throw new EditError(`Scene "${id}" is never closed, so the video cannot be edited safely.`)
    spans.push({
      position: 0,
      start: open.start,
      end,
      openStart: open.start,
      openEnd: open.end,
      id,
      durationMs: Number(attrValue(open.attrs, "data-duration-ms")) || 5000,
      transition: attrValue(open.attrs, "data-transition") || "cut",
      transitionMs: Number(attrValue(open.attrs, "data-transition-ms")) || 300,
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
  const re = new RegExp(`(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i")
  const found = re.exec(tag)
  if (found)
    return `${tag.slice(0, found.index)}${found[1]}"${value}"${tag.slice(found.index + found[0].length)}`
  const close = tag.lastIndexOf(">")
  return close < 0 ? tag : `${tag.slice(0, close)} ${name}="${value}"${tag.slice(close)}`
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
      out = out.slice(0, scene.openStart) + opening + out.slice(scene.openEnd)
    } else if (raw.op === "scene-delete") {
      if (scenes.length === 1) throw new EditError("A video must keep at least one scene.")
      out = out.slice(0, scene.start) + out.slice(scene.end)
    } else if (raw.op === "scene-duplicate") {
      const copy = setAttr(out.slice(scene.start, scene.end), "data-derive-scene", freshId(scenes))
      out = `${out.slice(0, scene.end)}\n${copy}${out.slice(scene.end)}`
    } else if (raw.op === "scene-move") {
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
    }
  }
  return out
}

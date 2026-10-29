/**
 * The image viewer: click a picture in an artifact and it opens full-frame over the
 * page, grown out of the spot it sat in, with every other picture on the page an
 * arrow key away. Bundled into the anchor client (anchor-client.ts mounts it), so it
 * runs INSIDE the sandboxed frame — where the images are. Whatever an image's source
 * (a bundle asset, a data: URI, a blob: an authored script minted), the frame can
 * show it; the host, on another origin, often can't.
 *
 * It leaves the artifact's DOM alone apart from one transient attribute on the image
 * under the pointer (the zoom-in cursor). Its own UI is mounted only while open: a
 * shadow root (the page's selectors can't reach inside) on a host element styled
 * inline with !important, shown in the top layer, so neither the page's CSS nor a
 * transformed ancestor can hide it or pull it out of place, and a picture inside an
 * open <dialog> opens above that dialog.
 *
 * What counts as a picture: an <img> big enough to be content (not an icon), not
 * inside a link or control, and not one the page made clickable itself (it set a
 * pointer cursor). Authors opt a subtree out with data-derive-zoom="off".
 */

import { CHROME } from "./source-tokens"

export const ZOOMABLE_ATTR = "data-derive-zoomable"
/** Joins the client's stylesheet: the cursor that says "this opens". */
export const ZOOMABLE_CSS = `[${ZOOMABLE_ATTR}]{cursor:zoom-in!important}`

export interface ImageViewerHost {
  /** May a click open the viewer right now? (Not while editing, reviewing, or in a
   *  deck, where clicks already mean something.) */
  allowed: () => boolean
  /** Comments are open to this viewer: show the Comment action. */
  canComment: () => boolean
  /** Start a comment on this image. Called after the viewer has closed, so the
   *  image's rect is where it sits on the page again. */
  comment: (img: HTMLImageElement) => void
}

const OWNS_CLICK = `a[href],button,label,summary,[role=button],[role=link],[onclick],${CHROME},[data-derive-zoom=off]`
const VECTOR = /^data:image\/svg|\.svg(?:[?#]|$)/i
const MIN_SIDE = 48 // rendered: smaller is a glyph, not a picture
const MIN_NATURAL = 160 // intrinsic: an icon drawn large has nothing more to show
const EASE = "cubic-bezier(.2,.8,.2,1)"

const ICON = {
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  prev: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  comment: '<path d="M5 5h14v10H10l-5 4z"/>',
}
const svg = (d: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`

const CSS =
  ":host{all:initial}" +
  '.v{position:fixed;inset:0;z-index:2147483647;outline:none;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;color:#f4f4f5;-webkit-font-smoothing:antialiased}' +
  ".bg{position:absolute;inset:0;background:rgba(16,16,17,.97);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);opacity:0;transition:opacity .26s ease}" +
  "[hidden]{display:none!important}" +
  ".v.on .bg{opacity:1}" +
  ".pic{position:absolute;display:block;max-width:none;max-height:none;margin:0;transform-origin:50% 50%;will-change:transform;-webkit-user-drag:none;cursor:zoom-in}" +
  ".v.zoomed .pic{cursor:grab}.v.zoomed.drag .pic{cursor:grabbing}" +
  ".ui{opacity:0;transition:opacity .2s ease}.v.on .ui{opacity:1}" +
  ".top{position:absolute;top:0;left:0;right:0;height:52px;display:flex;align-items:center;justify-content:space-between;padding:0 10px 0 20px;box-sizing:border-box}" +
  ".count{color:rgba(244,244,245,.55);font-variant-numeric:tabular-nums;letter-spacing:.01em}" +
  ".acts{display:flex;gap:2px;margin-left:auto}" +
  ".btn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;min-width:34px;padding:0 8px;border-radius:8px;color:rgba(244,244,245,.7);cursor:pointer;transition:background-color .15s,color .15s,opacity .2s}" +
  ".btn:hover{background:rgba(255,255,255,.09);color:#fff}" +
  ".btn:focus-visible,.th:focus-visible{box-shadow:0 0 0 2px rgba(255,255,255,.55)}" +
  ".btn svg{width:18px;height:18px;flex:none}" +
  ".nav{position:absolute;top:50%;margin-top:-22px;width:44px;height:44px;border-radius:999px;background:rgba(255,255,255,.06)}" +
  ".nav:hover{background:rgba(255,255,255,.14)}" +
  ".nav svg{width:20px;height:20px}" +
  ".prev{left:16px}.next{right:16px}" +
  ".nav[disabled]{opacity:0!important;pointer-events:none}" +
  ".foot{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;align-items:center;gap:12px;padding:0 16px 16px;box-sizing:border-box;pointer-events:none}" +
  ".cap{max-width:min(640px,100%);text-align:center;color:rgba(244,244,245,.75);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}" +
  ".cap:empty{display:none}" +
  ".strip{display:flex;gap:6px;max-width:100%;overflow-x:auto;padding:2px;scrollbar-width:none;pointer-events:auto}" +
  ".strip::-webkit-scrollbar{display:none}" +
  ".th{all:unset;flex:none;height:40px;border-radius:3px;overflow:hidden;opacity:.38;cursor:pointer;transition:opacity .15s,box-shadow .15s}" +
  ".th img{display:block;width:100%;height:100%;object-fit:cover}" +
  ".th:hover{opacity:.7}" +
  ".th[aria-current=true]{opacity:1;box-shadow:0 0 0 1.5px rgba(255,255,255,.9)}" +
  ".v.zoomed .nav,.v.zoomed .foot{opacity:0;pointer-events:none}" +
  "@media (max-width:640px){.nav{display:none}.top{padding-left:16px}.lbl{display:none}}" +
  "@media (prefers-reduced-motion:reduce){*{transition-duration:0s!important}}"

const isVector = (img: HTMLImageElement) => VECTOR.test(img.currentSrc || img.src)

const onScreen = (r: DOMRect) =>
  r.width > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth

const captionOf = (img: HTMLImageElement): string => {
  const fig = img.closest("figure")?.querySelector("figcaption")?.textContent
  return (fig || img.alt || img.title || "").replace(/\s+/g, " ").trim().slice(0, 280)
}

export function imageViewer(host: ImageViewerHost) {
  /** The picture a click on `el` would open, or null. */
  const viewable = (el: Element | null): HTMLImageElement | null => {
    if (!(el instanceof HTMLImageElement) || !host.allowed()) return null
    if (el.closest(OWNS_CLICK)) return null
    // The page made it clickable itself: its click, not ours.
    if (
      !el.hasAttribute(ZOOMABLE_ATTR) &&
      /^(pointer|zoom-in|zoom-out)$/.test(getComputedStyle(el).cursor)
    )
      return null
    const r = el.getBoundingClientRect()
    if (r.width < MIN_SIDE || r.height < MIN_SIDE) return null
    const n = Math.max(el.naturalWidth, el.naturalHeight)
    if (el.complete && n > 0 && n < MIN_NATURAL && !isVector(el)) return null
    return el
  }

  let open = false
  let closing = false
  let tappedAt = 0 // a tap or swipe closed it: its click is still on the way
  let returnFocus: HTMLElement | null = null
  let shadow: ShadowRoot
  let root: HTMLDivElement | null = null
  let v: HTMLDivElement
  let bg: HTMLDivElement
  let count: HTMLDivElement
  let cap: HTMLDivElement
  let strip: HTMLDivElement
  let prevBtn: HTMLButtonElement
  let nextBtn: HTMLButtonElement
  let commentBtn: HTMLButtonElement
  let list: HTMLImageElement[] = []
  let at = 0
  let pic: HTMLImageElement | null = null
  let nat = { w: 1, h: 1, vector: false }
  // The fitted rect (scale 1), then the zoom on top of it.
  let box = { x: 0, y: 0, w: 1, h: 1 }
  let s = 1
  let tx = 0
  let ty = 0
  let full = 2 // a click zooms here: 1:1 pixels, and never less than 2x
  // The zoom-in cursor, set only on the image under the pointer and only while it's there.
  let hovered: HTMLImageElement | null = null
  document.addEventListener("mouseover", (e) => {
    const img = open ? null : viewable(e.target instanceof Element ? e.target : null)
    if (img === hovered) return
    hovered?.removeAttribute(ZOOMABLE_ATTR)
    hovered = img
    hovered?.setAttribute(ZOOMABLE_ATTR, "")
  })
  // Leaving the frame from the image fires no mouseover; don't leave the attribute
  // behind for an edit session to find.
  document.addEventListener("mouseout", (e) => {
    if (e.target !== hovered) return
    hovered?.removeAttribute(ZOOMABLE_ATTR)
    hovered = null
  })

  const motion = () => !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

  const gallery = (): HTMLImageElement[] => {
    const seen = new Set<string>()
    const out: HTMLImageElement[] = []
    for (const img of Array.from(document.images)) {
      if (out.length >= 500) break
      const key = img.currentSrc || img.src
      if (!key || seen.has(key) || !viewable(img)) continue
      seen.add(key)
      out.push(img)
    }
    return out
  }

  const cur = () => list[at] as HTMLImageElement
  // The overlay's own box: innerWidth counts a classic scrollbar, the overlay doesn't.
  const vw = () => v.clientWidth || innerWidth
  const vh = () => v.clientHeight || innerHeight
  const transform = () => `translate(${tx}px,${ty}px) scale(${s})`
  const apply = (animate = false) => {
    if (!pic) return
    pic.style.transition = animate && motion() ? `transform .3s ${EASE}` : "none"
    pic.style.transform = transform()
    v.classList.toggle("zoomed", s > 1.01)
  }

  // Keep a zoomed picture covering the screen, and a fitted one on it.
  const clamp = () => {
    const W = box.w * s
    const H = box.h * s
    const cx = box.x + box.w / 2
    const cy = box.y + box.h / 2
    const ax = W / 2 - cx
    const bx = vw() - cx - W / 2
    const ay = H / 2 - cy
    const by = vh() - cy - H / 2
    tx = Math.min(Math.max(tx, Math.min(ax, bx)), Math.max(ax, bx))
    ty = Math.min(Math.max(ty, Math.min(ay, by)), Math.max(ay, by))
  }

  const layout = () => {
    if (!pic) return
    const many = list.length > 1
    const side = vw() > 640 ? (many ? 76 : 32) : 12
    const top = 52
    const bottom = 16 + (cap.textContent ? 44 : 0) + (strip.childElementCount ? 52 : 0)
    const aw = Math.max(1, vw() - side * 2)
    const ah = Math.max(1, vh() - top - bottom)
    const shown = cur().getBoundingClientRect().width
    // Never larger than the pixels it has (a vector has as many as it likes), but
    // never smaller than it already sat on the page.
    const limit = nat.vector ? Number.POSITIVE_INFINITY : Math.max(nat.w, shown)
    const k = Math.min(aw / nat.w, ah / nat.h, limit / nat.w)
    const w = nat.w * k
    const h = nat.h * k
    box = { x: (vw() - w) / 2, y: top + (ah - h) / 2, w, h }
    full = nat.vector ? 3 : Math.max(2, nat.w / w)
    Object.assign(pic.style, {
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${w}px`,
      height: `${h}px`,
    })
    clamp()
    apply()
  }

  const zoomTo = (next: number, px = vw() / 2, py = vh() / 2, animate = true) => {
    const ns = Math.min(Math.max(next, 1), Math.max(full, 4))
    const cx = box.x + box.w / 2
    const cy = box.y + box.h / 2
    // The point under (px, py) stays under it.
    const lx = (px - cx - tx) / s
    const ly = (py - cy - ty) / s
    s = ns
    tx = px - cx - s * lx
    ty = py - cy - s * ly
    // Back at the fit, it's centred again, wherever the zoom had wandered.
    if (s <= 1.001) tx = ty = 0
    clamp()
    apply(animate)
  }
  const toggleZoom = (px: number, py: number) => (s > 1.01 ? zoomTo(1) : zoomTo(full, px, py))

  // From the picture's place on the page to the fitted box: translate + scale, with a
  // clip that reproduces the page's crop (object-fit: cover thumbnails) and radius.
  const fromPage = (r: DOMRect) => {
    const k = Math.max(r.width / box.w, r.height / box.h)
    const dx = r.left + r.width / 2 - (box.x + box.w / 2)
    const dy = r.top + r.height / 2 - (box.y + box.h / 2)
    const ix = Math.max(0, (box.w - r.width / k) / 2)
    const iy = Math.max(0, (box.h - r.height / k) / 2)
    const rad = Number.parseFloat(getComputedStyle(cur()).borderTopLeftRadius) || 0
    return {
      transform: `translate(${dx}px,${dy}px) scale(${k})`,
      clipPath: `inset(${iy}px ${ix}px round ${rad / k}px)`,
    }
  }
  const atRest = { transform: "translate(0px,0px) scale(1)", clipPath: "inset(0px 0px round 0px)" }

  const chrome = () => {
    const n = list.length
    count.textContent = n > 1 ? `${at + 1} of ${n}` : ""
    cap.textContent = captionOf(cur())
    prevBtn.disabled = at === 0
    nextBtn.disabled = at === n - 1
    prevBtn.hidden = nextBtn.hidden = n < 2
    commentBtn.hidden = !host.canComment()
    const th = strip.children[at] as HTMLElement | undefined
    for (const t of Array.from(strip.children)) t.setAttribute("aria-current", String(t === th))
    if (th)
      strip.scrollTo({
        left: th.offsetLeft - (strip.clientWidth - th.offsetWidth) / 2,
        behavior: motion() ? "smooth" : "auto",
      })
  }

  const show = (i: number, how: "open" | "next" | "prev" | "jump") => {
    const src = list[i] as HTMLImageElement
    const old = pic
    const next = document.createElement("img")
    next.className = "pic"
    next.alt = src.alt
    next.draggable = false
    next.src = src.currentSrc || src.src
    pic = next
    at = i
    s = 1
    tx = ty = 0
    chrome()
    next.style.opacity = "0"
    v.insertBefore(next, bg.nextSibling)

    const ready = () => {
      next.onload = next.onerror = null // the srcset upgrade below loads again
      if (pic !== next) return
      const r = src.getBoundingClientRect()
      const w = next.naturalWidth || src.naturalWidth
      const h = next.naturalHeight || src.naturalHeight
      // No intrinsic size (an SVG without one, a broken load): use the page's shape,
      // and let it scale like a vector.
      nat =
        w && h
          ? { w, h, vector: isVector(src) }
          : { w: r.width || 1, h: r.height || 1, vector: true }
      layout()
      next.style.opacity = ""
      if (!motion()) return
      if (how === "open") {
        if (onScreen(r)) next.animate([fromPage(r), atRest], { duration: 320, easing: EASE })
        else
          next.animate(
            [
              { opacity: 0, transform: "scale(.97)" },
              { opacity: 1, transform: "scale(1)" },
            ],
            220,
          )
      } else if (how !== "jump") {
        const d = how === "next" ? 1 : -1
        next.animate(
          [
            { opacity: 0, transform: `translate(${d * 36}px,0px)` },
            { opacity: 1, transform: "translate(0px,0px)" },
          ],
          { duration: 240, easing: EASE },
        )
      }
    }
    if (next.complete && next.naturalWidth) ready()
    else {
      next.onload = ready
      next.onerror = ready
    }

    // A srcset renders the candidate the page's layout wanted; full-frame wants a
    // bigger one. Swap it in once it's decoded.
    if (src.srcset) {
      const hi = new Image()
      hi.sizes = "100vw"
      hi.srcset = src.srcset
      hi.src = src.src
      hi.decode()
        .then(() => {
          if (pic !== next || !hi.currentSrc || hi.currentSrc === next.src) return
          next.src = hi.currentSrc
          nat = { w: hi.naturalWidth, h: hi.naturalHeight, vector: false }
          if (s <= 1.01) layout()
        })
        .catch(() => {})
    }

    if (old) {
      const d = how === "next" ? -1 : 1
      const leave =
        motion() && how !== "jump"
          ? old.animate(
              [
                { opacity: 1, transform: old.style.transform },
                { opacity: 0, transform: `translate(${d * 36}px,0px) ${old.style.transform}` },
              ],
              { duration: 180, easing: "ease-in", fill: "forwards" },
            )
          : null
      if (leave) leave.onfinish = () => old.remove()
      else old.remove()
    }
  }

  const go = (d: number) => {
    const i = at + d
    if (i >= 0 && i < list.length && i !== at) show(i, d > 0 ? "next" : "prev")
  }

  const close = (then?: () => void) => {
    if (!open || closing || !root || !pic) return
    closing = true
    window.removeEventListener("keydown", onKey, true)
    window.removeEventListener("resize", layout)
    const src = cur()
    let r = src.getBoundingClientRect()
    // Paged to a picture that's scrolled away: bring it into view behind the scrim,
    // so the picture lands back in its place and the reader is where they looked.
    if (!onScreen(r) && r.width > 0) {
      window.scrollTo(scrollX, scrollY + r.top - (innerHeight - r.height) / 2)
      r = src.getBoundingClientRect()
    }
    v.classList.remove("on")
    const done = () => {
      root?.remove()
      root = pic = null
      open = closing = false
      pts.clear()
      pinch = null
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
      then?.()
    }
    if (!motion()) return done()
    const from = { transform: pic.style.transform || atRest.transform, clipPath: atRest.clipPath }
    pic.style.transition = "none"
    const anim = onScreen(r)
      ? pic.animate([from, fromPage(r)], { duration: 260, easing: EASE, fill: "forwards" })
      : pic.animate(
          [
            { opacity: 1, transform: from.transform },
            { opacity: 0, transform: `${from.transform} scale(.96)` },
          ],
          { duration: 180, fill: "forwards" },
        )
    anim.onfinish = done
  }

  function onKey(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const k = e.key
    // The viewer is modal: no key reaches the page behind it, and Tab stays inside.
    e.stopImmediatePropagation()
    const focused = shadow.activeElement
    if (k === "Tab") {
      e.preventDefault()
      const stops = Array.from(v.querySelectorAll("button")).filter(
        (b) =>
          !b.hidden &&
          !b.disabled &&
          b.offsetParent !== null &&
          // Zoomed, the arrows and filmstrip fade out: not tab stops either.
          !(v.classList.contains("zoomed") && b.closest(".nav,.foot")),
      )
      if (!stops.length) return
      const i = stops.indexOf(focused as HTMLButtonElement)
      const step = e.shiftKey ? -1 : 1
      const to =
        i < 0 ? (e.shiftKey ? stops.length - 1 : 0) : (i + step + stops.length) % stops.length
      stops[to]?.focus({ preventScroll: true })
      return
    }
    if ((k === " " || k === "Enter") && focused instanceof HTMLButtonElement) return // its own activation
    e.preventDefault()
    if (k === "Escape") close()
    else if (k === "ArrowRight") go(1)
    else if (k === "ArrowLeft") go(-1)
    else if (k === "Home") go(-at)
    else if (k === "End") go(list.length - 1 - at)
    else if (k === "+" || k === "=") zoomTo(s * 1.6)
    else if (k === "-") zoomTo(s / 1.6)
    else if (k === "0") zoomTo(1)
  }

  /* Pointer grammar. Mouse: click the picture to zoom to 1:1 and back, drag to pan,
     click the dark to close. Touch: double-tap to zoom, pinch, swipe sideways to page,
     swipe down to close. Trackpad: pinch (ctrl+wheel) zooms, two-finger pans. */
  const pts = new Map<number, { x: number; y: number }>()
  let start = { x: 0, y: 0 }
  let moved = false
  let axis: "x" | "y" | null = null
  let pinch: { d: number; s: number } | null = null
  let lastTap = 0
  const two = () => Array.from(pts.values()) as [{ x: number; y: number }, { x: number; y: number }]
  const dist = () => {
    const [a, b] = two()
    return Math.hypot(a.x - b.x, a.y - b.y)
  }
  const mid = () => {
    const [a, b] = two()
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }
  const onControl = (e: Event) =>
    e.target instanceof Element && !!e.target.closest(".btn,.th,.strip")

  const onDown = (e: PointerEvent) => {
    if (onControl(e) || closing || (e.pointerType === "mouse" && e.button !== 0)) return
    v.setPointerCapture?.(e.pointerId)
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pts.size === 1) {
      start = { x: e.clientX, y: e.clientY }
      moved = false
      axis = null
    } else if (pts.size === 2) {
      pinch = { d: dist() || 1, s }
      moved = true
    }
    if (s > 1.01) v.classList.add("drag")
  }
  const onMove = (e: PointerEvent) => {
    const p = pts.get(e.pointerId)
    if (!p || !pic) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    p.x = e.clientX
    p.y = e.clientY
    if (pinch && pts.size === 2) {
      const m = mid()
      zoomTo((pinch.s * dist()) / pinch.d, m.x, m.y, false)
      return
    }
    const ox = e.clientX - start.x
    const oy = e.clientY - start.y
    if (!moved && Math.hypot(ox, oy) > 6) moved = true
    if (!moved) return
    if (s > 1.01) {
      tx += dx
      ty += dy
      clamp()
      apply()
      return
    }
    if (e.pointerType === "mouse") return
    axis ??= Math.abs(ox) > Math.abs(oy) ? "x" : "y"
    pic.style.transition = "none"
    if (axis === "x") pic.style.transform = `translate(${ox}px,0px)`
    else {
      pic.style.transform = `translate(0px,${oy}px) scale(${1 - Math.min(Math.abs(oy) / 2000, 0.15)})`
      bg.style.opacity = String(1 - Math.min(Math.abs(oy) / 400, 0.7))
    }
  }
  const onUp = (e: PointerEvent) => {
    if (!pts.has(e.pointerId)) return
    pts.delete(e.pointerId)
    v.classList.remove("drag")
    if (pinch) {
      if (pts.size < 2) pinch = null
      if (pts.size === 1) {
        const [p] = two()
        start = { x: p.x, y: p.y }
      }
      return
    }
    if (pts.size || !pic) return
    const ox = e.clientX - start.x
    const oy = e.clientY - start.y
    if (!moved) {
      // Hit-tested, not read off the target: pointer capture retargets the up to `v`.
      const pr = pic.getBoundingClientRect()
      const onPic =
        e.clientX >= pr.left &&
        e.clientX <= pr.right &&
        e.clientY >= pr.top &&
        e.clientY <= pr.bottom
      if (!onPic) return closeByTap()
      if (e.pointerType === "mouse") return toggleZoom(e.clientX, e.clientY)
      if (Date.now() - lastTap < 300) {
        lastTap = 0
        return toggleZoom(e.clientX, e.clientY)
      }
      lastTap = Date.now()
      return
    }
    if (s > 1.01 || !axis) return
    bg.style.opacity = ""
    if (axis === "x" && Math.abs(ox) > 60 && (ox < 0 ? at < list.length - 1 : at > 0))
      return go(ox < 0 ? 1 : -1)
    if (axis === "y" && Math.abs(oy) > 90) return closeByTap()
    apply(true) // not far enough: settle back
  }

  const closeByTap = () => {
    tappedAt = Date.now()
    close()
  }

  // The browser took the gesture back (a system swipe, a scroll it claimed): forget
  // it and settle, without reading it as a tap or a swipe.
  const onCancel = (e: PointerEvent) => {
    pts.delete(e.pointerId)
    if (pts.size < 2) pinch = null
    if (pts.size === 1) {
      const [p] = two()
      start = { x: p.x, y: p.y }
    }
    v.classList.remove("drag")
    bg.style.opacity = ""
    if (!pts.size) apply(true)
  }

  let wheelX = 0
  let wheelAt = 0
  const onWheel = (e: WheelEvent) => {
    e.preventDefault() // the page under the scrim doesn't scroll
    if (e.ctrlKey) return zoomTo(s * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY, false)
    if (s > 1.01) {
      tx -= e.deltaX
      ty -= e.deltaY
      clamp()
      apply()
      return
    }
    // A sideways two-finger swipe pages, once per gesture.
    const now = Date.now()
    if (now - wheelAt > 250) wheelX = 0
    wheelAt = now
    if (wheelX === Number.POSITIVE_INFINITY) return
    wheelX += e.deltaX
    if (Math.abs(wheelX) > 80 && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      go(wheelX > 0 ? 1 : -1)
      wheelX = Number.POSITIVE_INFINITY
    }
  }

  const button = (cls: string, label: string, icon: string, text = "") => {
    const b = document.createElement("button")
    b.type = "button"
    b.className = `btn ${cls}`
    b.setAttribute("aria-label", label)
    b.title = label
    b.innerHTML = svg(icon) + (text ? `<span class="lbl">${text}</span>` : "")
    return b
  }

  const mount = () => {
    root = document.createElement("div")
    root.className = "derive-edit-ui derive-image-viewer"
    // The page's CSS can still match the host element itself (`div:empty`, `* {…}`):
    // inline !important outranks any author rule.
    root.style.cssText =
      "all:initial!important;display:block!important;position:fixed!important;inset:0!important;z-index:2147483647!important"
    shadow = root.attachShadow({ mode: "open" })
    shadow.innerHTML = `<style>${CSS}</style>`
    v = document.createElement("div")
    v.className = "v"
    v.tabIndex = -1
    v.setAttribute("role", "dialog")
    v.setAttribute("aria-modal", "true")
    v.setAttribute("aria-label", "Image viewer")
    bg = document.createElement("div")
    bg.className = "bg"
    const top = document.createElement("div")
    top.className = "ui top"
    count = document.createElement("div")
    count.className = "count"
    count.setAttribute("aria-live", "polite")
    const acts = document.createElement("div")
    acts.className = "acts"
    commentBtn = button("", "Comment on this image", ICON.comment, "Comment")
    const closeBtn = button("", "Close", ICON.close)
    acts.append(commentBtn, closeBtn)
    top.append(count, acts)
    prevBtn = button("ui nav prev", "Previous image", ICON.prev)
    nextBtn = button("ui nav next", "Next image", ICON.next)
    const foot = document.createElement("div")
    foot.className = "ui foot"
    cap = document.createElement("div")
    cap.className = "cap"
    strip = document.createElement("div")
    strip.className = "strip"
    foot.append(cap, strip)
    v.append(bg, top, prevBtn, nextBtn, foot)
    shadow.append(v)

    // The filmstrip: worth its row when there's something to browse and room for it.
    if (list.length > 1 && list.length <= 200 && innerHeight >= 520)
      list.forEach((img, i) => {
        const t = document.createElement("button")
        t.type = "button"
        t.className = "th"
        t.setAttribute("aria-label", `Image ${i + 1}`)
        const r = img.getBoundingClientRect()
        const aspect = (img.naturalWidth || r.width) / (img.naturalHeight || r.height) || 1
        t.style.width = `${Math.round(Math.min(Math.max(40 * aspect, 28), 72))}px`
        const ti = document.createElement("img")
        ti.src = img.currentSrc || img.src
        ti.alt = ""
        ti.loading = "lazy"
        ti.draggable = false
        t.append(ti)
        t.addEventListener("click", () => i !== at && show(i, "jump"))
        strip.append(t)
      })

    closeBtn.addEventListener("click", () => close())
    prevBtn.addEventListener("click", () => go(-1))
    nextBtn.addEventListener("click", () => go(1))
    commentBtn.addEventListener("click", () => {
      const img = cur()
      close(() => host.comment(img))
    })
    v.addEventListener("pointerdown", onDown)
    v.addEventListener("pointermove", onMove)
    v.addEventListener("pointerup", onUp)
    v.addEventListener("pointercancel", onCancel)
    v.addEventListener("wheel", onWheel, { passive: false })
    v.addEventListener("contextmenu", (e) => e.target === pic || e.preventDefault())
    // In the top layer, so a transformed <html> or an open <dialog> can't sit over
    // it; inside that dialog, if the picture is in one, so the modal doesn't make it
    // inert.
    const modal = list[at]?.closest("dialog[open]")
    // The page closing that dialog takes the viewer's box with it: close the viewer too.
    modal?.addEventListener("close", () => close(), { once: true })
    ;(modal ?? document.documentElement).append(root)
    try {
      root.popover = "manual"
      root.showPopover()
    } catch {}
  }

  /** Open the viewer on `img` (already `viewable`). */
  const openOn = (img: HTMLImageElement) => {
    if (open) return
    list = gallery()
    at = list.indexOf(img)
    if (at < 0) {
      // A repeat of an earlier picture (or one past the cap): it stands in for that
      // entry, so closing and commenting land on the copy that was clicked.
      const key = img.currentSrc || img.src
      at = list.findIndex((x) => (x.currentSrc || x.src) === key)
      if (at >= 0) list[at] = img
      else at = list.push(img) - 1
    }
    open = true
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    hovered?.removeAttribute(ZOOMABLE_ATTR)
    hovered = null
    mount()
    window.addEventListener("keydown", onKey, true)
    window.addEventListener("resize", layout)
    show(at, "open")
    v.focus({ preventScroll: true })
    requestAnimationFrame(() => v.classList.add("on"))
  }

  return {
    /** Is the viewer showing? The client's own click, key and selection handling
     *  stands down while it is. */
    isOpen: () => open,
    /** Edit or review mode is starting: those own the page's clicks and keys. */
    close: () => close(),
    viewable,
    /** The tap that closed the viewer still turns into a click on whatever was under
     *  it (at once, with reduced motion): a link would open, a picture reopen, a
     *  highlight open its thread. Eat that one click; a close by key or button leaves
     *  the next click alone. Checked before any other click handling. */
    swallow: (e: MouseEvent): boolean => {
      if (open || Date.now() - tappedAt > 400) return false
      tappedAt = 0
      e.preventDefault()
      e.stopImmediatePropagation()
      return true
    },
    /** A click on the page: open the viewer if it landed on a picture. */
    click: (e: MouseEvent): boolean => {
      if (open || e.button !== 0 || e.defaultPrevented) return false
      const img = viewable(e.target instanceof Element ? e.target : null)
      if (!img) return false
      e.stopPropagation()
      openOn(img)
      return true
    },
  }
}

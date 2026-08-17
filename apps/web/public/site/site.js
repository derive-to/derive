const THEME_KEY = "derive-theme"
const systemTheme = window.matchMedia("(prefers-color-scheme: light)")

function storedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY)
    if (value === "light" || value === "dark" || value === "system") return value
  } catch {
    // Storage can be unavailable in hardened browsing modes. System still works.
  }
  return "system"
}

function applyTheme() {
  const mode = storedTheme()
  const light = mode === "light" || (mode === "system" && systemTheme.matches)
  document.documentElement.classList.toggle("light", light)
  document.documentElement.classList.toggle("dark", !light)

  for (const button of document.querySelectorAll("[data-theme-toggle]")) {
    button.dataset.theme = mode
    button.setAttribute("aria-label", `Color theme: ${mode}. Activate to change.`)
    button.title = `Color theme: ${mode}`
  }
}

function cycleTheme() {
  const order = ["system", "light", "dark"]
  const next = order[(order.indexOf(storedTheme()) + 1) % order.length]
  try {
    localStorage.setItem(THEME_KEY, next)
  } catch {
    // The current page can still use the system theme when storage is blocked.
  }
  applyTheme()
}

function initNav() {
  const nav = document.querySelector("[data-site-nav]")
  if (nav) {
    const updateBorder = () => nav.classList.toggle("is-scrolled", window.scrollY > 8)
    updateBorder()
    addEventListener("scroll", updateBorder, { passive: true })
  }

  for (const menu of document.querySelectorAll(".mobile-nav")) {
    menu.addEventListener("toggle", () => {
      document.documentElement.classList.toggle("menu-open", menu.open)
      menu
        .querySelector("summary")
        ?.setAttribute("aria-label", menu.open ? "Close navigation menu" : "Open navigation menu")
    })
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && menu.open) {
        menu.open = false
        menu.querySelector("summary")?.focus()
      }
    })
    for (const link of menu.querySelectorAll("a")) {
      link.addEventListener("click", () => {
        menu.open = false
      })
    }
  }
}

function initCopyButtons() {
  const status = document.querySelector("[data-copy-status]")
  for (const button of document.querySelectorAll("[data-copy], [data-copy-from]")) {
    button.addEventListener("click", async () => {
      const source = button.dataset.copyFrom
        ? document.getElementById(button.dataset.copyFrom)?.textContent.trim()
        : button.dataset.copy
      if (!source || button.dataset.copying === "true") return

      try {
        await navigator.clipboard.writeText(source)
      } catch {
        return
      }

      button.dataset.copying = "true"
      const label = button.querySelector("[data-copy-label]") ?? button
      const previous = label.textContent
      label.textContent = button.dataset.copiedLabel ?? "Copied"
      if (status) status.textContent = "Copied to clipboard"

      setTimeout(() => {
        delete button.dataset.copying
        label.textContent = previous
        if (status) status.textContent = ""
      }, 1800)
    })
  }
}

function initWaitlists() {
  for (const form of document.querySelectorAll("[data-waitlist]")) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault()
      const input = form.elements.namedItem("email")
      if (!(input instanceof HTMLInputElement) || !input.validity.valid) {
        input?.focus()
        return
      }

      const button = form.querySelector("button[type='submit']")
      if (!(button instanceof HTMLButtonElement)) return
      const previous = button.textContent
      button.disabled = true
      button.textContent = "Sending..."

      let ok = false
      try {
        const response = await fetch(form.action, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: input.value.trim(),
            source_kind: form.dataset.deriveSource,
            landing_path: location.pathname,
          }),
        })
        ok = response.ok
      } catch {
        // The visible retry state below handles network failures.
      }

      if (!ok) {
        button.disabled = false
        button.textContent = "Try again"
        setTimeout(() => {
          button.textContent = previous
        }, 2400)
        return
      }

      form.hidden = true
      const complete = form.parentElement?.querySelector("[data-waitlist-complete]")
      if (complete instanceof HTMLElement) complete.hidden = false
    })
  }
}

function initHomeDemo() {
  const demo = document.querySelector("[data-home-demo]")
  if (!(demo instanceof HTMLElement)) return

  const versions = {
    1: {
      heading: "OSC-8 Synthesizer",
      summary: "A portable eight-voice synthesizer with a built-in speaker and battery.",
      meta: "HTML · v1",
      badge: "Draft",
      comments: "0",
      message: "First draft",
    },
    2: {
      heading: "Eight voices. Zero menus.",
      summary: "Every parameter is already on the surface. No pages, no shift keys, no manual.",
      meta: "HTML · v2",
      badge: "Updated",
      comments: "2",
      message: "Product drawing and clearer direction",
    },
    3: {
      heading: "Eight voices. Zero menus.",
      summary: "Every parameter is already on the surface. No pages, no shift keys, no manual. Battery for an afternoon.",
      meta: "HTML · v3",
      badge: "Current",
      comments: "3",
      message: "Measured specs added after review",
    },
  }

  const heading = demo.querySelector("[data-demo-heading]")
  const summary = demo.querySelector("[data-demo-summary]")
  const meta = demo.querySelector("[data-demo-meta]")
  const badge = demo.querySelector("[data-demo-badge]")
  const comments = demo.querySelector("[data-demo-comment-count]")
  const versionLabel = demo.querySelector("[data-demo-version-label]")
  const versionMessage = demo.querySelector("[data-demo-version-message]")
  const playButton = demo.querySelector("[data-demo-play]")
  const playLabel = demo.querySelector("[data-demo-play-label]")
  const progress = demo.querySelector("[data-demo-progress]")
  const playerStatus = demo.querySelector("[data-demo-player-status]")
  const announcement = demo.querySelector("[data-demo-announcement]")
  const demoBody = demo.querySelector(".home-demo-body")
  const cursor = demo.querySelector("[data-demo-cursor]")
  const cursorLabel = demo.querySelector("[data-demo-cursor-label]")
  const buttons = [...demo.querySelectorAll("[data-demo-version]")]

  const showVersion = (version, shouldAnnounce = false) => {
    const next = versions[version]
    if (!next) return
    demo.dataset.version = String(version)
    if (heading) heading.textContent = next.heading
    if (summary) summary.textContent = next.summary
    if (meta) meta.textContent = next.meta
    if (badge) badge.textContent = next.badge
    if (comments) comments.textContent = next.comments
    if (versionLabel) versionLabel.textContent = `v${version}`
    if (versionMessage) versionMessage.textContent = next.message
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(button.dataset.demoVersion === String(version)))
    }
    if (shouldAnnounce && announcement) {
      announcement.textContent = `Version ${version} published. ${next.message}.`
    }
  }

  if (
    !(playButton instanceof HTMLButtonElement) ||
    !(progress instanceof HTMLElement) ||
    !(playerStatus instanceof HTMLElement) ||
    !(demoBody instanceof HTMLElement) ||
    !(cursor instanceof HTMLElement)
  ) {
    for (const button of buttons) {
      button.addEventListener("click", () => showVersion(button.dataset.demoVersion))
    }
    return
  }

  const duration = 12_400
  const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)")
  let elapsed = 0
  let frame = 0
  let lastFrame = 0
  let nextScene = 0
  let playing = false
  let pausedByReader = false
  let hasStarted = false
  let inView = false
  let currentStatus = "Current version"
  let currentCursorTarget = ""

  const setPlayLabel = (label) => {
    if (playLabel) playLabel.textContent = label
    playButton.setAttribute("aria-label", label)
  }

  const setStatus = (status) => {
    currentStatus = status
    playerStatus.textContent = status
  }

  const setProgress = (value) => {
    progress.style.transform = `scaleX(${Math.max(0, Math.min(1, value))})`
  }

  const hideCursor = () => {
    currentCursorTarget = ""
    delete demo.dataset.demoCursorVisible
  }

  const moveCursor = (person, targetName) => {
    const target = demo.querySelector(`[data-demo-target="${targetName}"]`)
    if (!(target instanceof HTMLElement) && !(target instanceof SVGElement)) return

    const bodyBox = demoBody.getBoundingClientRect()
    const targetBox = target.getBoundingClientRect()
    const x = Math.max(
      10,
      Math.min(
        demoBody.clientWidth - 92,
        targetBox.left - bodyBox.left + targetBox.width * 0.62,
      ),
    )
    const y = Math.max(
      10,
      Math.min(
        demoBody.clientHeight - 36,
        targetBox.top - bodyBox.top + targetBox.height * 0.48,
      ),
    )
    cursor.style.setProperty("--demo-cursor-x", `${x}px`)
    cursor.style.setProperty("--demo-cursor-y", `${y}px`)
    if (cursorLabel) cursorLabel.textContent = person
    currentCursorTarget = targetName
    demo.dataset.demoCursorVisible = "true"
  }

  const setScene = ({ name, status, focus = "", person = "", target = "", commentCount }) => {
    demo.dataset.demoScene = name
    if (focus) demo.dataset.demoFocus = focus
    else delete demo.dataset.demoFocus
    if (person && target) moveCursor(person, target)
    else hideCursor()
    if (commentCount !== undefined && comments) comments.textContent = String(commentCount)
    setStatus(status)
  }

  const scenes = [
    {
      at: 0,
      version: "1",
      name: "draft",
      status: "v1 published. Ready for review.",
      commentCount: 0,
    },
    {
      at: 900,
      name: "review-image",
      status: "Maeva is reviewing the product image.",
      focus: "image",
      person: "Maeva",
      target: "image",
      commentCount: 0,
    },
    {
      at: 1_800,
      name: "comment-image",
      status: "Maeva comments on the missing product image.",
      focus: "image",
      person: "Maeva",
      target: "image",
      commentCount: 1,
    },
    {
      at: 3_200,
      name: "review-headline",
      status: "Maeva moves to the headline.",
      focus: "headline",
      person: "Maeva",
      target: "headline",
      commentCount: 1,
    },
    {
      at: 4_100,
      name: "comment-headline",
      status: "Maeva asks for a more specific headline.",
      focus: "headline",
      person: "Maeva",
      target: "headline",
      commentCount: 2,
    },
    {
      at: 5_200,
      name: "revising-v2",
      status: "The agent is updating the artifact.",
      commentCount: 2,
    },
    {
      at: 6_400,
      version: "2",
      name: "published-v2",
      status: "v2 published. Maeva's comments are addressed.",
      commentCount: 2,
    },
    {
      at: 7_600,
      name: "review-price",
      status: "Anya is reviewing the price.",
      focus: "price",
      person: "Anya",
      target: "price",
      commentCount: 2,
    },
    {
      at: 8_600,
      name: "comment-price",
      status: "Anya asks for facts behind the price.",
      focus: "price",
      person: "Anya",
      target: "price",
      commentCount: 3,
    },
    {
      at: 9_900,
      name: "revising-v3",
      status: "The agent is adding measured specifications.",
      commentCount: 3,
    },
    {
      at: 11_100,
      version: "3",
      name: "published-v3",
      status: "v3 published. The current artifact is ready to share.",
      commentCount: 3,
    },
  ]

  const cancelFrame = () => {
    if (frame) window.cancelAnimationFrame(frame)
    frame = 0
    lastFrame = 0
  }

  const finish = () => {
    cancelFrame()
    playing = false
    pausedByReader = false
    demo.dataset.demoPlaying = "false"
    demo.dataset.demoScene = "complete"
    delete demo.dataset.demoFocus
    hideCursor()
    setProgress(1)
    setStatus("Walkthrough complete. v3 is ready to share.")
    setPlayLabel("Replay walkthrough")
  }

  const tick = (time) => {
    frame = 0
    if (!playing || !inView || document.hidden) return
    if (!lastFrame) lastFrame = time
    elapsed = Math.min(duration, elapsed + time - lastFrame)
    lastFrame = time

    while (nextScene < scenes.length && elapsed >= scenes[nextScene].at) {
      const scene = scenes[nextScene]
      if (scene.version) showVersion(scene.version, true)
      setScene(scene)
      nextScene += 1
    }
    setProgress(elapsed / duration)

    if (elapsed >= duration) finish()
    else frame = window.requestAnimationFrame(tick)
  }

  const resumeWhenVisible = () => {
    if (!playing || !inView || document.hidden || frame) return
    lastFrame = 0
    frame = window.requestAnimationFrame(tick)
  }

  const startWalkthrough = () => {
    cancelFrame()
    elapsed = 0
    nextScene = 0
    playing = true
    pausedByReader = false
    hasStarted = true
    demo.dataset.demoPlaying = "true"
    setProgress(0)
    setPlayLabel("Pause walkthrough")
    resumeWhenVisible()
  }

  const pauseWalkthrough = () => {
    cancelFrame()
    playing = false
    pausedByReader = true
    demo.dataset.demoPlaying = "false"
    playerStatus.textContent = `Paused. ${currentStatus}`
    setPlayLabel("Continue walkthrough")
  }

  const resumeWalkthrough = () => {
    playing = true
    pausedByReader = false
    demo.dataset.demoPlaying = "true"
    playerStatus.textContent = currentStatus
    setPlayLabel("Pause walkthrough")
    resumeWhenVisible()
  }

  const stopForVersion = (version) => {
    cancelFrame()
    playing = false
    pausedByReader = false
    hasStarted = true
    demo.dataset.demoPlaying = "false"
    demo.dataset.demoScene = version === "3" ? "current" : `version-${version}`
    delete demo.dataset.demoFocus
    hideCursor()
    showVersion(version)
    const selected = versions[version]
    setProgress(version === "1" ? 0 : version === "2" ? 0.56 : 1)
    setStatus(selected?.message ?? "Artifact version selected")
    setPlayLabel(version === "3" ? "Replay walkthrough" : "Play walkthrough")
    if (announcement && selected) {
      announcement.textContent = `Showing version ${version}. ${selected.message}.`
    }
  }

  for (const button of buttons) {
    button.addEventListener("click", () => stopForVersion(button.dataset.demoVersion ?? "3"))
  }

  if (motionPreference.matches) {
    playButton.hidden = true
    setProgress(1)
    setStatus("Motion reduced. Choose a version below.")
    return
  }

  playButton.addEventListener("click", () => {
    inView = true
    if (playing) pauseWalkthrough()
    else if (pausedByReader) resumeWalkthrough()
    else startWalkthrough()
  })

  const observer = new IntersectionObserver(
    ([entry]) => {
      inView = Boolean(entry?.isIntersecting)
      if (inView && !hasStarted) startWalkthrough()
      else if (inView) resumeWhenVisible()
      else cancelFrame()
    },
    { threshold: 0.25 },
  )
  observer.observe(demo)

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancelFrame()
    else resumeWhenVisible()
  })

  window.addEventListener("resize", () => {
    if (currentCursorTarget && cursorLabel) {
      moveCursor(cursorLabel.textContent ?? "", currentCursorTarget)
    }
  })
}

applyTheme()

document.addEventListener("DOMContentLoaded", () => {
  applyTheme()
  initNav()
  initCopyButtons()
  initWaitlists()
  initHomeDemo()
  for (const button of document.querySelectorAll("[data-theme-toggle]")) {
    button.addEventListener("click", cycleTheme)
  }
})

systemTheme.addEventListener("change", () => {
  if (storedTheme() === "system") applyTheme()
})

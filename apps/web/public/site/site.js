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
  const buttons = [...demo.querySelectorAll("[data-demo-version]")]

  const showVersion = (version) => {
    const next = versions[version]
    if (!next) return
    demo.dataset.version = version
    if (heading) heading.textContent = next.heading
    if (summary) summary.textContent = next.summary
    if (meta) meta.textContent = next.meta
    if (badge) badge.textContent = next.badge
    if (comments) comments.textContent = next.comments
    if (versionLabel) versionLabel.textContent = `v${version}`
    if (versionMessage) versionMessage.textContent = next.message
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(button.dataset.demoVersion === version))
    }
  }

  for (const button of buttons) {
    button.addEventListener("click", () => showVersion(button.dataset.demoVersion))
  }
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

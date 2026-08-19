/* Theme control for the public marketing pages.
 *
 * The stored choice is one of "dark", "light" or "system". A small inline
 * script in each page's <head> applies the resolved class before first paint,
 * so this file only has to keep the button and the class in step afterwards.
 *
 * Pages that need to react to a theme change (a canvas that paints its own
 * colours, for instance) listen for the "derive:theme" event on document
 * rather than reaching into this file.
 */
;(() => {
  const KEY = "derive-theme"
  const ORDER = ["dark", "light", "system"]
  const sysLight = matchMedia("(prefers-color-scheme: light)")
  const button = document.querySelector("[data-theme-toggle]")

  const mode = () => {
    let stored = null
    try {
      stored = localStorage.getItem(KEY)
    } catch {}
    return stored === "light" || stored === "system" ? stored : "dark"
  }

  const apply = () => {
    const current = mode()
    const light = current === "light" || (current === "system" && sysLight.matches)
    const classes = document.documentElement.classList
    classes.toggle("light", light)
    classes.toggle("dark", !light)
    if (button) {
      button.dataset.mode = current
      button.setAttribute("aria-label", `Theme: ${current}`)
      button.title = `Theme: ${current}`
    }
    document.dispatchEvent(new CustomEvent("derive:theme", { detail: { light, mode: current } }))
  }

  button?.addEventListener("click", () => {
    const next = ORDER[(ORDER.indexOf(mode()) + 1) % ORDER.length]
    try {
      localStorage.setItem(KEY, next)
    } catch {}
    apply()
  })

  sysLight.addEventListener("change", () => {
    if (mode() === "system") apply()
  })

  apply()
})()

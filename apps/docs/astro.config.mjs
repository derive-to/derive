import { unified } from "@astrojs/markdown-remark"
import mdx from "@astrojs/mdx"
import sitemap from "@astrojs/sitemap"
import { defineConfig } from "astro/config"

const buildSha = process.env.GITHUB_SHA ?? "dev"

// Starlight makes wide tables independently scrollable. Safari keyboard users
// need the scroll container itself in the tab order, so enforce that on every
// generated documentation table instead of relying on authors to remember it.
function keyboardScrollableTables() {
  return (tree) => {
    const visit = (node) => {
      if (node.type === "element" && node.tagName === "table") {
        node.properties ??= {}
        node.properties.tabIndex = 0
      }
      for (const child of node.children ?? []) visit(child)
    }
    visit(tree)
  }
}

export default defineConfig({
  site: "https://docs.derive.to",
  trailingSlash: "always",
  markdown: { processor: unified({ rehypePlugins: [keyboardScrollableTables] }) },
  integrations: [mdx(), sitemap()],
  vite: {
    define: {
      __DERIVE_DOCS_BUILD__: JSON.stringify(buildSha),
    },
  },
})

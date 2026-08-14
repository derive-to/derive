import { unified } from "@astrojs/markdown-remark"
import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"
import { docsSections } from "./docs-manifest.mjs"

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
  integrations: [
    starlight({
      title: "Derive Docs",
      description:
        "Publish agent-made work, collect exact feedback, revise it, and record approval at one durable URL.",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/custom.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/derive-to/derive",
        },
      ],
      head: [
        {
          tag: "meta",
          attrs: { name: "theme-color", content: "#5f45ff" },
        },
        {
          tag: "meta",
          attrs: { name: "derive-docs-build", content: buildSha },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: "https://derive.to/site/og-approval.png",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:image",
            content: "https://derive.to/site/og-approval.png",
          },
        },
        {
          tag: "link",
          attrs: { rel: "alternate", type: "text/plain", href: "/llms.txt", title: "LLM index" },
        },
      ],
      lastUpdated: true,
      pagination: true,
      disable404Route: true,
      sidebar: [
        { label: "Documentation home", link: "/" },
        ...docsSections.map(({ label, pages }) => ({
          label,
          items: pages.map(({ slug }) => ({ slug })),
        })),
        {
          label: "Links",
          collapsed: true,
          items: [
            {
              label: "Open Derive",
              link: "https://derive.to/?src=docs_nav",
              attrs: { rel: "external" },
            },
            {
              label: "GitHub repository",
              link: "https://github.com/derive-to/derive",
              attrs: { rel: "external" },
            },
          ],
        },
      ],
    }),
  ],
})

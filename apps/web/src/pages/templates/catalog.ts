// Templates and Context manifests are portable product data. Keep the web app on
// the exact catalog that MCP reads rather than copying a second definition here.
export {
  ARTIFACT_TEMPLATES,
  BUILT_IN_TEMPLATES,
  CONTEXT_TEMPLATES,
  getTemplate,
  listTemplates,
  TEMPLATE_CATEGORIES,
  templateMatches,
} from "@derive-to/templates"

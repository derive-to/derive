import {
  getTemplate,
  renderTemplate,
  type TemplateDraft as SharedTemplateDraft,
  type TemplateVisualTheme,
} from "@derive-to/templates"
import { BUILT_IN_THEMES, getTheme } from "./catalog"
import type { BuiltInTheme } from "./types"

export type TemplateDraft = SharedTemplateDraft & { theme?: BuiltInTheme }

// These are authored artifact bytes, not app UI. Literal colors ship inside the
// self-contained draft and cannot reference Derive's runtime token system. PR 2
// moves these recipes into the Themes catalog; PR 1 passes them as an adapter to
// the portable Template renderer so browser and MCP structure stay identical.
const THEME_CSS: Record<string, string> = {
  "editorial-ink": `--bg:#f4f1e9;--fg:#1c1a17;--mut:#6e675e;--line:#cfc7ba;--accent:#aa3f2b;--display:Georgia,serif;--body:"Helvetica Neue",sans-serif;--radius:0px`,
  "operator-briefing": `--bg:#101215;--fg:#f2f3f4;--mut:#a6aab0;--line:#34383e;--accent:#d3d6da;--display:"Helvetica Neue",sans-serif;--body:"Helvetica Neue",sans-serif;--radius:2px`,
  "field-notes": `--bg:#eee9dd;--fg:#20231f;--mut:#687066;--line:#c8c5b8;--accent:#49634e;--display:Georgia,serif;--body:"Trebuchet MS",sans-serif;--radius:10px`,
  "quiet-institutional": `--bg:#f1f2f3;--fg:#20242a;--mut:#6b717a;--line:#cfd3d8;--accent:#3d4652;--display:Georgia,serif;--body:"Helvetica Neue",sans-serif;--radius:3px`,
  "high-signal": `--bg:#f3f1eb;--fg:#121212;--mut:#595959;--line:#bdb9af;--accent:#d94a2f;--display:"Arial Black",Impact,sans-serif;--body:"Helvetica Neue",sans-serif;--radius:0px`,
}

const visualThemeFor = (theme: BuiltInTheme): TemplateVisualTheme => ({
  id: theme.id,
  css: THEME_CSS[theme.id] ?? THEME_CSS["editorial-ink"] ?? "",
})

// The browser preserves the current Theme beta behavior through an adapter. The
// shared renderer owns Template structure and bytes; Themes becomes a first-class
// catalog in the follow-up without re-copying template source.
export function buildTemplateDraft(
  templateId: string | undefined,
  themeId: string | undefined,
): TemplateDraft | undefined {
  const template = getTemplate(templateId)
  if (!template) return undefined
  const requestedTheme = getTheme(themeId)
  const fallbackTheme = BUILT_IN_THEMES[0]
  const theme = template.themeMode === "fixed" ? undefined : (requestedTheme ?? fallbackTheme)
  const draft = renderTemplate(template.id, theme ? visualThemeFor(theme) : undefined)
  return draft ? { ...draft, theme } : undefined
}

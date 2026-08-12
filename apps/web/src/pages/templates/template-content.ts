import { getTemplate, renderTemplate, type TemplateDraft } from "@derive-to/templates"

// Browser, MCP, and future clients all resolve the same catalog entry and receive
// the same deterministic source. The editor always receives an independent draft.
export function buildTemplateDraft(
  templateId: string | undefined,
  values?: Readonly<Record<string, string>>,
): TemplateDraft | undefined {
  const template = getTemplate(templateId)
  return template ? renderTemplate(template.id, values) : undefined
}

import type { TemplateInput } from "../types"

export const input = (name: string, description: string, required = false): TemplateInput => ({
  name,
  description,
  required,
})

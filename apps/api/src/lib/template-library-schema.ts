import { isMissingTable } from "./missing-table"

export const isTemplateLibrarySchemaUnavailable = (error: unknown): boolean =>
  isMissingTable(error, ["template_library", "template_library_entry"])

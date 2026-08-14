import { TEMPLATE_ENTRY_FORMATS, TEMPLATE_ENTRY_KINDS, TEMPLATE_LIBRARY_SCOPES } from "@derive/core"
import { BUILT_INS_LIBRARY_ID, TEMPLATE_CATALOG_VERSION } from "@derive-to/templates"
import { z } from "@hono/zod-openapi"

const TemplateLibraryScopeSchema = z.enum(TEMPLATE_LIBRARY_SCOPES)
const TemplateEntryKindSchema = z.enum(TEMPLATE_ENTRY_KINDS)
const TemplateEntryFormatSchema = z.enum(TEMPLATE_ENTRY_FORMATS)

export const TemplateLibraryListQuerySchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  scope: TemplateLibraryScopeSchema.optional(),
  q: z.string().trim().max(200).optional(),
})

const TemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240),
  required: z.boolean().optional(),
})

export const BuiltInTemplateSchema = z
  .object({
    id: z.string(),
    kind: TemplateEntryKindSchema,
    category: z.enum(["Deck", "Doc", "Report", "Site", "Agent"]),
    format: TemplateEntryFormatSchema,
    title: z.string(),
    defaultTitle: z.string(),
    description: z.string(),
    outcome: z.string(),
    sections: z.array(z.string()),
    inputs: z.array(TemplateInputSchema),
    tags: z.array(z.string()),
    featured: z.boolean().optional(),
    starterPrompts: z.array(z.string()).optional(),
    libraryId: z.literal(BUILT_INS_LIBRARY_ID),
    catalogVersion: z.literal(TEMPLATE_CATALOG_VERSION),
  })
  .openapi("BuiltInTemplate")

export const TemplateLibraryEntrySchema = z
  .object({
    id: z.string(),
    library_id: z.string(),
    source_version: z.number().describe("Pinned source version captured on publication."),
    kind: TemplateEntryKindSchema,
    category: z.string(),
    format: TemplateEntryFormatSchema,
    title: z.string(),
    description: z.string(),
    outcome: z.string(),
    sections: z.array(z.string()),
    inputs: z.array(TemplateInputSchema),
    tags: z.array(z.string()),
    created_at: z.string(),
  })
  .openapi("TemplateLibraryEntry")

const TemplateLibraryPublisherSchema = z.object({
  name: z.string().nullable(),
  username: z.string().nullable(),
  image: z.string().nullable(),
})

export const TemplateLibrarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    scope: TemplateLibraryScopeSchema.describe(
      "private = owner only; workspace = workspace members; public = anyone with the library URL or catalog.",
    ),
    created_at: z.string(),
    updated_at: z.string().nullable(),
    entry_count: z.number(),
    entries: z.array(TemplateLibraryEntrySchema).optional(),
    publisher: TemplateLibraryPublisherSchema,
    can_manage: z.boolean().optional(),
  })
  .openapi("TemplateLibrary")

export const CreateTemplateLibrarySchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  scope: TemplateLibraryScopeSchema.optional(),
})

export const UpdateTemplateLibrarySchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  scope: TemplateLibraryScopeSchema.optional(),
})

export const CreateTemplateLibraryEntrySchema = z.object({
  source_short_id: z.string().trim().min(1),
  source_version: z.number().int().positive().optional(),
  kind: TemplateEntryKindSchema,
  category: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500),
  outcome: z.string().trim().max(300),
  sections: z.array(z.string().trim().min(1).max(120)).max(30),
  inputs: z.array(TemplateInputSchema).max(20),
  tags: z.array(z.string().trim().min(1).max(48)).max(20),
})

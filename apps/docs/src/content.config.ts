import { defineCollection } from "astro:content"
import { glob } from "astro/loaders"
import { z } from "astro/zod"

export const collections = {
  docs: defineCollection({
    loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/docs" }),
    schema: z.object({
      slug: z.string(),
      title: z.string(),
      description: z.string(),
      editUrl: z.url(),
      lastUpdated: z.union([z.coerce.date(), z.literal(false)]),
    }),
  }),
}

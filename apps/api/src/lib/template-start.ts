import { z } from "zod"

/** Trusted navigation metadata for an agent job that began in the template catalog. */
export const TemplateStartSchema = z.object({
  uri: z
    .string()
    .regex(
      /^(?:[0-9a-z]{6,12}|derive:\/\/(?:templates\/[a-z0-9-]+|template-libraries\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+))$/,
    ),
  title: z.string().trim().min(1).max(200),
  kind: z.enum(["artifact", "context"]),
})

export type TemplateStart = z.infer<typeof TemplateStartSchema>

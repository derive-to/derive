import { CONTEXT_ENVIRONMENT_LIMIT, contextEnvironmentNameError } from "@derive/core"
import { z } from "@hono/zod-openapi"

export const EnvironmentBindings = z
  .record(
    z.string().superRefine((name, ctx) => {
      const error = contextEnvironmentNameError(name)
      if (error) ctx.addIssue({ code: "custom", message: error })
    }),
    z.string().min(1).max(64),
  )
  .refine(
    (bindings) => Object.keys(bindings).length <= CONTEXT_ENVIRONMENT_LIMIT,
    `At most ${CONTEXT_ENVIRONMENT_LIMIT} environment variables`,
  )

export const readEnvironmentBindings = (value: string | null): Record<string, string> => {
  if (!value) return {}
  return EnvironmentBindings.parse(JSON.parse(value))
}

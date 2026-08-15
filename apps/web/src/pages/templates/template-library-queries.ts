import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query"
import { api, type TemplateLibraryScope } from "@/api"

const normalizedQuery = (query?: string) => query?.trim() || undefined

export const templateLibraryQueryKeys = {
  all: ["template-libraries"] as const,
  list: (scope?: TemplateLibraryScope, query?: string) =>
    [
      "template-libraries",
      "list",
      { scope: scope ?? "all", query: normalizedQuery(query) ?? "" },
    ] as const,
  detail: (id: string) => ["template-libraries", "detail", id] as const,
}

export const templateLibrariesQuery = ({
  scope,
  query,
}: {
  scope?: TemplateLibraryScope
  query?: string
} = {}) => {
  const q = normalizedQuery(query)
  return infiniteQueryOptions({
    queryKey: templateLibraryQueryKeys.list(scope, q),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listTemplateLibraries({ cursor: pageParam, limit: 30, scope, q }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  })
}

export const templateLibraryQuery = (id: string) =>
  queryOptions({
    queryKey: templateLibraryQueryKeys.detail(id),
    queryFn: () => api.getTemplateLibrary(id),
  })

// One prefix reconciles lists and details across signed-in and public surfaces.
export const templateLibraryInvalidation = [templateLibraryQueryKeys.all]

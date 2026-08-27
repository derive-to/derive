import type { ExportJob, ExportKind } from "@/api"

interface ExportOption {
  label: string
  order: Partial<Record<"page" | "deck", number>>
  requiresDataSlot?: boolean
  email?: boolean
  supportsPublicImage?: boolean
}

export const EXPORT_OPTIONS: Record<ExportKind, ExportOption> = {
  page_pdf: { label: "Page PDF", order: { page: 0, deck: 2 } },
  chart_png: {
    label: "Chart image (PNG)",
    order: { page: 1 },
    supportsPublicImage: true,
  },
  chart_json: {
    label: "Declared data (JSON)",
    order: { page: 2 },
    requiresDataSlot: true,
  },
  chart_csv: {
    label: "Declared table (CSV)",
    order: { page: 3 },
    requiresDataSlot: true,
  },
  email: {
    label: "Send as email",
    order: { page: 4, deck: 3 },
    email: true,
    supportsPublicImage: true,
  },
  deck_pdf: { label: "Slide deck (PDF)", order: { deck: 0 } },
  deck_pptx: { label: "Slide deck (PPTX)", order: { deck: 1 } },
}

export const exportChoices = (isDeck: boolean): ExportKind[] => {
  const artifact = isDeck ? "deck" : "page"
  return (Object.entries(EXPORT_OPTIONS) as [ExportKind, ExportOption][])
    .filter(([, option]) => option.order[artifact] !== undefined)
    .sort(([, a], [, b]) => (a.order[artifact] ?? 0) - (b.order[artifact] ?? 0))
    .map(([kind]) => kind)
}

export const isActiveExportJob = (job: ExportJob): boolean =>
  job.status === "pending" || job.status === "rendering" || job.status === "failed"

import type { Artifact } from "@/api"
import { artifactTemplateFormat } from "./artifact-template-format"

export type AddEntryState = {
  step: "source" | "details"
  source: string
  selectedSource: Artifact | null
  kind: "artifact" | "context"
  category: string
  title: string
  description: string
}

export const initialAddEntryState = (): AddEntryState => ({
  step: "source",
  source: "",
  selectedSource: null,
  kind: "artifact",
  category: "Doc",
  title: "",
  description: "",
})

type TextField = Exclude<keyof AddEntryState, "step" | "selectedSource" | "kind">

export type AddEntryAction =
  | { type: "reset" }
  | { type: "set-step"; step: AddEntryState["step"] }
  | { type: "set-kind"; kind: AddEntryState["kind"] }
  | { type: "set-field"; field: TextField; value: string }
  | { type: "paste-source"; source: string }
  | { type: "select-source"; artifact: Artifact }

export const reduceAddEntry = (state: AddEntryState, action: AddEntryAction): AddEntryState => {
  switch (action.type) {
    case "reset":
      return initialAddEntryState()
    case "set-step":
      return { ...state, step: action.step }
    case "set-kind":
      return { ...state, kind: action.kind }
    case "set-field":
      return { ...state, [action.field]: action.value }
    case "paste-source":
      return { ...initialAddEntryState(), source: action.source }
    case "select-source": {
      const format = artifactTemplateFormat(action.artifact.current_content_type)
      if (!format || action.artifact.kind !== "file") return state
      return {
        ...initialAddEntryState(),
        source: action.artifact.short_id,
        selectedSource: action.artifact,
        title: action.artifact.title || "Reusable starter",
        category: format.category,
      }
    }
  }
}

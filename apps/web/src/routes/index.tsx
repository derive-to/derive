import { createFileRoute } from "@tanstack/react-router"
import { Library } from "../pages/Library"

export const Route = createFileRoute("/")({
  component: Library,
})

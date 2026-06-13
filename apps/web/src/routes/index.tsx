import { createFileRoute } from "@tanstack/react-router"
import { Library } from "../pages/library"

export const Route = createFileRoute("/")({
  component: Library,
})

import { createFileRoute } from "@tanstack/react-router"
import { PublicCollection } from "../pages/library/public-collection"

export const Route = createFileRoute("/collections/$id")({
  component: PublicCollection,
})

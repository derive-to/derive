import { createFileRoute } from "@tanstack/react-router"
import { Login } from "../pages/Login"

export const Route = createFileRoute("/login")({
  // `?signup` deep-links straight into the create-account form (the anon viral
  // CTA on a shared artifact links here).
  validateSearch: (s: Record<string, unknown>): { signup?: boolean } =>
    s.signup ? { signup: true } : {},
  component: Login,
})

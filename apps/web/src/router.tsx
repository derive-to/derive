import { createRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"

// TanStack Start calls getRouter() to build the client router. Route tree is
// generated from src/routes/* by the Start vite plugin.
export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
  })
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}

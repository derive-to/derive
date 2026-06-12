import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { AuthProvider, ThemeProvider } from "./ctx"
import { Login } from "./pages/Login"
import { Library } from "./pages/Library"
import { Artifact } from "./pages/Artifact"
import "./styles.css"

const rootRoute = createRootRoute({ component: () => <Outlet /> })
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Library })
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: Login })
const artifactRoute = createRoute({ getParentRoute: () => rootRoute, path: "/a/$ref", component: Artifact })

const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, loginRoute, artifactRoute]),
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>,
)

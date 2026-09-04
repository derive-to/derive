// Vite's `?raw` import (used by tests to load LaTeX fixtures as strings). Ambient so the
// runtime-agnostic core never needs node:fs to read a file.
declare module "*?raw" {
  const text: string
  export default text
}

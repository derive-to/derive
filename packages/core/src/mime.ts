const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  tex: "text/x-latex; charset=utf-8",
  latex: "text/x-latex; charset=utf-8",
  // The rest of a paper bundle. Served as plain text so a .bib or .cls reads truthfully
  // under nosniff instead of falling to application/octet-stream.
  bib: "text/plain; charset=utf-8",
  bbl: "text/plain; charset=utf-8",
  cls: "text/plain; charset=utf-8",
  sty: "text/plain; charset=utf-8",
  bst: "text/plain; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  pdf: "application/pdf",
  wasm: "application/wasm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  csv: "text/csv; charset=utf-8",
  map: "application/json; charset=utf-8",
}

export const mimeFor = (path: string): string => {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return TYPES[ext] ?? "application/octet-stream"
}

/**
 * ACM's TAPS production system accepts a fixed list of LaTeX packages; a submission that
 * loads anything else is bounced back to the authors. A paper written in Derive against
 * the acmart class should hear about that at publish time, not at camera-ready. The list
 * mirrors www.acm.org/publications/taps/accepted-latex-packages ("Last updated: April
 * 2025"); `mathptmx` is added from the older machine-readable list ACM published, which
 * still accepted it. Update both sets together when ACM changes the page.
 *
 * Leaf module: no imports.
 */

export const TAPS_ACCEPTED_PACKAGES: ReadonlySet<string> = new Set([
  "abstract",
  "acronym",
  "algorithm",
  "algorithm2e",
  "algorithmic",
  "alltt",
  "amsbsy",
  "amscd",
  "amsfonts",
  "amsgen",
  "amsmath",
  "amsmidx",
  "amsopn",
  "amssymb",
  "amstext",
  "amsthm",
  "amsxtra",
  "apacite",
  "appendix",
  "auxhook",
  "balance",
  "bbding",
  "bbold",
  "bm",
  "bold-braces",
  "braket",
  "breakurl",
  "calc",
  "cancel",
  "ccicons",
  "centernot",
  "cgloss4e",
  "changes",
  "checkend",
  "CJK",
  "clean",
  "cleveref",
  "cmap",
  "color",
  "colortbl",
  "comma",
  "coollist",
  "coolstr",
  "crossreftools",
  "curves",
  "datenumber",
  "dcolumn",
  "decimal",
  "delarray",
  "dirtytalk",
  "draftwatermark",
  "enumitem",
  "epigraph",
  "epstopdf",
  "esdiff",
  "etex",
  "eucal",
  "eufrak",
  "fancybox",
  "fancyhdr",
  "fancyvrb",
  "fix-cm",
  "fixfoot",
  "fixltx2e",
  "fixme",
  "flafter",
  "float",
  "fontawesome",
  "fontawesome5",
  "fontenc",
  "forloop",
  "fp",
  "framed",
  "gb4e",
  "geometry",
  "glossaries",
  "graphics",
  "graphicx",
  "graphpap",
  "harmony",
  "html",
  "hyperref",
  "ifpdf",
  "ifthen",
  "index",
  "inputenc",
  "iopams",
  "keyval",
  "kvoptions",
  "listings",
  "lscape",
  "makecell",
  "makeidx",
  "maple2e",
  "mapleenv",
  "mapleplots",
  "maplestyle",
  "mapletab",
  "mapleutil",
  "mathabx",
  "mathptmx",
  "mathtool",
  "mathtools",
  "mciteplus",
  "microtype",
  "multirow",
  "natbib",
  "newlfont",
  "nicefrac",
  "nomencl",
  "nopageno",
  "oldlfont",
  "overword",
  "physics",
  "pifont",
  "rotating",
  "setspace",
  "shortvrb",
  "showidx",
  "SIunits",
  "siunitx",
  "stfloats",
  "stmaryrd",
  "soul",
  "subcaption",
  "subfig",
  "subfigure",
  "suffix",
  "svg",
  "tabular",
  "textcase",
  "textcomp",
  "textgreek",
  "tfrupee",
  "tipa",
  "tipx",
  "titlepage",
  "tloop",
  "totpages",
  "trimspaces",
  "units",
  "upmath",
  "url",
  "verbatim",
  "wrapfig",
  "xcolor",
  "xfrac",
  "xspace",
])

/** Packages acmart already loads. Loading one again in the source is refused by TAPS
 *  (and usually breaks the class's own option choices). */
export const ACMART_BUNDLED_PACKAGES: ReadonlySet<string> = new Set([
  "amsart",
  "amsmath",
  "babel",
  "balance",
  "booktabs",
  "caption",
  "cmap",
  "comment",
  "draftwatermark",
  "environ",
  "etoolbox",
  "fancyhdr",
  "float",
  "fontenc",
  "framed",
  "geometry",
  "graphicx",
  "hyperref",
  "hyperxmp",
  "iftex",
  "libertine",
  "manyfoot",
  "microtype",
  "natbib",
  "newtxmath",
  "pbalance",
  "refcount",
  "setspace",
  "totpages",
  "unicode-math",
  "xcolor",
  "xkeyval",
  "xstring",
  "zi4",
  "zref-savepos",
  "zref-user",
])

/** Packages Derive itself provides in the source export (derive.sty). */
const DERIVE_PACKAGES = new Set(["derive"])

const USEPACKAGE = /^[ \t]*\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]*)\}/gm

/** Package names loaded by `\usepackage` / `\RequirePackage` lines that are not commented
 *  out, in source order, deduplicated. */
export const loadedPackages = (source: string): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of source.matchAll(USEPACKAGE)) {
    for (const raw of (m[1] ?? "").split(",")) {
      const name = raw.trim()
      if (name && !seen.has(name)) {
        seen.add(name)
        out.push(name)
      }
    }
  }
  return out
}

/** Advisories for an acmart document: packages TAPS does not accept, and packages acmart
 *  already bundles. Empty for other classes, where the list does not apply. */
export const tapsPackageAdvisories = (source: string): string[] => {
  if (!/^[ \t]*\\documentclass(?:\[[^\]]*\])?\{acmart\}/m.test(source)) return []
  const out: string[] = []
  for (const name of loadedPackages(source)) {
    if (DERIVE_PACKAGES.has(name)) continue
    if (ACMART_BUNDLED_PACKAGES.has(name))
      out.push(
        `\\usepackage{${name}}: acmart already loads ${name}; remove the line before submitting to TAPS`,
      )
    else if (!TAPS_ACCEPTED_PACKAGES.has(name))
      out.push(`\\usepackage{${name}}: ${name} is not on ACM TAPS's accepted package list`)
  }
  return out
}

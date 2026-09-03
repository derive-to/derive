# CVPR paper

This folder is a paper on Derive in the shape of the CVPR author kit: `main.tex` is the
source the page is rendered from, `main.bib` holds the citations, and `derive.sty`
provides `\derivetable{name}` and `\derivefigure{name}`, the tables and figures that
update without a new version.

## Style files

`cvpr.sty` and `ieeenat_fullname.bst` belong to the CVPR author kit
(https://github.com/cvpr-org/author-kit), which carries no license, so Derive does not
ship them. When a paper is created from this template in Derive, they are fetched from a
pinned commit of the kit into the bundle. If they are not next to this file, download
the two files from the kit and add them before compiling.

## Compile it

- **Overleaf**: upload the zip from "Download LaTeX source", set `main.tex` as the main
  document and pdfLaTeX as the compiler.
- **Locally**: `pdflatex main && bibtex main && pdflatex main && pdflatex main`.

The download writes each dynamic slot's current value beside the sources as
`derive-dynamic/<name>.tex` (and the image file for a figure), so the compiled paper
shows the same data as the page. Edit the paper, not those fragments: the next download
regenerates them.

## Review and final versions

`\usepackage[review]{cvpr}` produces the anonymous review copy with line numbers and the
paper id (`\def\paperID{...}`). Switch to `\usepackage{cvpr}` for the camera-ready
version, which prints the author block.

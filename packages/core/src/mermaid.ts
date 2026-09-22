/** Browser-only, lazily loaded from the API's pinned package, never a public CDN. */
export const MERMAID_VERSION = "12.0.0"
export const MERMAID_ASSET_BASE = `/raw/vendor/mermaid/${MERMAID_VERSION}`
export const MERMAID_FILE_PATTERN =
  /^(mermaid\.esm\.min\.mjs|chunks\/mermaid\.esm\.min\/[A-Za-z0-9_-]+\.mjs)$/

// Source stays escaped in a normal code block until rendering succeeds. Keeping the
// runtime outside the sanitized Markdown avoids granting authored HTML any new powers.
// strict disables authored click callbacks; dompurifyConfig is also locked so a
// diagram's init directive cannot relax Mermaid's SVG sanitization.
export const MERMAID_HEAD = `<style>
figure.derive-mermaid{margin:1.6em 0;overflow:auto;text-align:center}
figure.derive-mermaid svg{max-width:100%;height:auto}
figure.derive-mermaid pre{text-align:left}
figure.derive-mermaid figcaption{color:var(--muted);text-align:left}
</style><script type="module">
const blocks = [...document.querySelectorAll('pre.derive-mermaid')];
try {
  const { default: mermaid } = await import('${MERMAID_ASSET_BASE}/mermaid.esm.min.mjs');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges',
      'suppressErrorRendering', 'dompurifyConfig']
  });
  for (const [index, block] of blocks.entries()) {
    const figure = document.createElement('figure');
    figure.className = 'derive-mermaid';
    figure.setAttribute('data-derive-readonly', '');
    try {
      const { svg } = await mermaid.render('derive-mermaid-' + index, block.textContent || '');
      figure.innerHTML = svg;
      block.replaceWith(figure);
    } catch {
      const caption = document.createElement('figcaption');
      caption.textContent = 'Could not render Mermaid diagram. Source shown below.';
      block.replaceWith(figure);
      figure.append(caption, block);
    }
  }
} catch {
  // A missing or blocked library leaves the original readable source in place.
}
</script>`

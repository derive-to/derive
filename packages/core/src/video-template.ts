/**
 * Canonical lightweight HTML-video starter. The visual remains ordinary authored HTML;
 * these data attributes are the small contract that lets Derive reuse its viewer,
 * Inspect, edit history, comments and sharing surfaces around it.
 */
export const VIDEO_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>New video</title>
<style>
*{box-sizing:border-box}html,body{height:100%;margin:0;overflow:hidden}body{background:#111;color:#fff;font-family:ui-sans-serif,system-ui}.video{position:fixed;inset:0;display:grid;place-items:center}.scene{position:absolute;inset:0;display:grid;place-items:center;padding:8vw;text-align:center;background:radial-gradient(circle at 50% 20%,#39425c,#111)}.scene:not([data-derive-video-active]):not(:first-child){display:none}h1,h2{max-width:16ch;margin:0;font-size:clamp(2.5rem,8vw,7rem);line-height:.95;letter-spacing:-.04em}p{max-width:38rem;font-size:clamp(1rem,2vw,1.5rem);line-height:1.5;color:#cbd5e1}
</style>
</head>
<body>
<main class="video" data-derive-video data-aspect-ratio="16/9" data-poster-scene="opening">
  <section class="scene" data-derive-scene="opening" data-derive-scene-title="Opening" data-derive-caption="Opening caption" data-duration-ms="4000" data-transition="fade" data-transition-ms="300">
    <div><h1>New video</h1><p>Click Edit, then type directly on this scene.</p></div>
  </section>
  <section class="scene" data-derive-scene="story" data-derive-scene-title="Story" data-derive-caption="Story caption" data-duration-ms="5000" data-transition="slide" data-transition-ms="350">
    <div><h2>Build the story in scenes.</h2><p>Timing, transitions and scene order live in Inspect.</p></div>
  </section>
  <section class="scene" data-derive-scene="close" data-derive-scene-title="Close" data-derive-caption="Closing caption" data-duration-ms="3500" data-transition="dissolve" data-transition-ms="300">
    <div><h2>Share one living link.</h2><p>Comments and revisions work like every other Derive artifact.</p></div>
  </section>
</main>
</body>
</html>`

export const videoTemplate = (title: string): string =>
  VIDEO_TEMPLATE.replaceAll("New video", title)

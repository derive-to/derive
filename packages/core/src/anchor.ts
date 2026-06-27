import type { CommentState } from "./ports"

/** A W3C Web Annotation TextQuoteSelector — survives republishing. */
export interface QuoteSelector {
  type: "TextQuoteSelector"
  exact: string
  prefix?: string
  suffix?: string
  /** Deck artifacts only: the 0-based slide the comment was made on. Undefined on
   *  ordinary documents. Resolution scopes to this slide first, then falls back to
   *  the whole document (so a comment survives text moving between slides). */
  slide?: number
}

const CONTEXT = 24

/** Build a quote selector for `text[start, start+length)` with surrounding context. */
export function quoteSelector(text: string, start: number, length: number): QuoteSelector {
  return {
    type: "TextQuoteSelector",
    exact: text.slice(start, start + length),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(start + length, start + length + CONTEXT),
  }
}

export interface Reanchor {
  found: boolean
  index: number
}

/**
 * Locate a quote selector in (possibly republished) text.
 * 1) exact match with prefix+suffix context, 2) exact match anywhere,
 * 3) not found → orphaned. Deterministic, no ML.
 */
export function reanchor(sel: QuoteSelector, text: string): Reanchor {
  if (!sel.exact) return { found: false, index: -1 }
  const withContext = `${sel.prefix ?? ""}${sel.exact}${sel.suffix ?? ""}`
  if (withContext !== sel.exact) {
    const i = text.indexOf(withContext)
    if (i >= 0) return { found: true, index: i + (sel.prefix?.length ?? 0) }
  }
  const j = text.indexOf(sel.exact)
  return j >= 0 ? { found: true, index: j } : { found: false, index: -1 }
}

/**
 * The comment-anchor client that runs inside the sandboxed artifact iframe.
 * The frame has an opaque origin, so everything rides postMessage:
 *
 *  frame → host:  select            (user selected text — a quote selector + screen rect)
 *                 anchors-resolved  (which ids matched, and the slide each landed in)
 *                 anchor-rects      (doc-absolute top of every painted highlight)
 *                 scroll            (live scroll offset — cards track their text)
 *                 anchor-click      (user clicked a highlight)
 *                 anchor-hover      (pointer entered/left a highlight)
 *                 cursor            (live pointer position for multiplayer cursors)
 *                 cursor-tap        (a click — peers ripple at this point)
 *                 cursor-leave      (pointer left / frame blurred — drop our cursor)
 *  host → frame:  anchors           (paint highlights for these anchors)
 *                 remeasure         (re-report highlight rects — e.g. after a slide flip)
 *                 focus-anchor      (scroll to + flash one anchor)
 *                 emphasize         (lift one anchor's highlight — host card hover)
 *
 * Served at /raw/dock-client.js with a SHORT cache and referenced by URL from
 * artifact HTML — the HTML itself is cached immutable, so baking the client
 * inline would freeze old behavior into every previously-viewed artifact.
 */
export const ANCHOR_CLIENT_JS = `(function(){
function post(m){m.source="dock";parent.postMessage(m,"*")}
function scrollTop(){return window.scrollY||document.documentElement.scrollTop||document.body.scrollTop||0}

/* -- selection capture: a text selection becomes a TextQuoteSelector + the
      on-screen rect of the selection, so the host can float a button beside it -- */
function emitSelection(){
  var s=window.getSelection(),t=s?s.toString().trim():"";
  // A tap fires a synthesized mouseup with no selection; don't let it clear the
  // block anchor we just placed (tapGuard, set in the touch handler below).
  if(!t||t.length<2){if(Date.now()-tapGuard<600)return;post({type:"select",selector:null,rect:null});return}
  var ctx=(s.anchorNode&&s.anchorNode.textContent)||t,i=ctx.indexOf(t);
  var rect=null;try{var r=s.getRangeAt(0).getBoundingClientRect();
    if(r&&(r.height||r.width))rect={top:r.top,bottom:r.bottom,left:r.left,right:r.right}}catch(_){}
  post({type:"select",rect:rect,selector:{type:"TextQuoteSelector",exact:t,
    prefix:i>=0?ctx.slice(Math.max(0,i-24),i):"",
    suffix:i>=0?ctx.slice(i+t.length,i+t.length+24):""}})}
document.addEventListener("mouseup",function(){setTimeout(emitSelection,0)});

/* Touch makes "select a phrase, then find a tiny floating button" miserable, and
   iOS pops its own Copy/Look-Up menu over wherever we'd place one. So on touch we
   (a) emit drag-selections on a debounced selectionchange (they glide as you drag
   the handles, no mouseup needed) and (b) treat a clean tap on a text block as a
   coarse "comment on this" anchor. The host shows a bottom bar for both; here we
   just report. tapGuard keeps the collapse that follows a tap from clearing it. */
var emitT=0,tapGuard=0,tx=0,ty=0,tMoved=false;
function scheduleEmit(){if(emitT)clearTimeout(emitT);emitT=setTimeout(emitSelection,120)}
document.addEventListener("selectionchange",function(){
  var s=window.getSelection();
  if(s&&!s.isCollapsed){scheduleEmit();return}
  if(Date.now()-tapGuard<600)return;
  post({type:"select",selector:null,rect:null})});
document.addEventListener("touchstart",function(e){
  var t=e.touches&&e.touches[0];if(t){tx=t.clientX;ty=t.clientY;tMoved=false}},{passive:true});
document.addEventListener("touchmove",function(e){
  var t=e.touches&&e.touches[0];
  if(t&&(Math.abs(t.clientX-tx)>10||Math.abs(t.clientY-ty)>10))tMoved=true},{passive:true});
document.addEventListener("touchend",function(e){
  var s=window.getSelection();
  if(s&&!s.isCollapsed){setTimeout(emitSelection,0);return}
  if(tMoved)return;
  var el=e.target;
  if(!el||!el.closest||el.closest("a,button,input,textarea,select,label,[data-dock-id]"))return;
  var b=el.closest("p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,figcaption,dd,dt,pre");
  if(!b)return;
  var txt=(b.textContent||"").trim();
  if(txt.length<2)return;
  var r=b.getBoundingClientRect();
  tapGuard=Date.now();flashBlock(b);
  post({type:"select",block:true,rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},
    selector:{type:"TextQuoteSelector",exact:txt.slice(0,180),prefix:"",suffix:""}})},{passive:true});
function flashBlock(b){var bg=b.style.backgroundColor,tr=b.style.transition;
  b.style.transition="background-color .15s ease";b.style.backgroundColor="rgba(101,89,153,.18)";
  setTimeout(function(){b.style.backgroundColor=bg;setTimeout(function(){b.style.transition=tr},220)},1000)}

/* -- live cursor: throttled pointer position, DOCUMENT-normalized 0..1 (x by
      width, y by the full document height, including scroll). The host maps it
      back against each viewer's own scroll, so a peer's cursor sits where they
      are IN THE DOCUMENT — not at a fixed screen spot — and glides as you scroll;
      peers scrolled out of view collapse into an edge indicator. Plus an explicit
      leave (pointer left the doc / frame blurred / tab hidden) so peers drop us at
      once, and a tap on click so peers can ripple where we acted. -- */
var cT=0;
document.addEventListener("mousemove",function(e){
  var n=Date.now();if(n-cT<40)return;cT=n;
  var w=window.innerWidth||1,dh=document.documentElement.scrollHeight||1;
  post({type:"cursor",x:e.clientX/w,y:(e.clientY+scrollTop())/dh})});
document.addEventListener("mousedown",function(e){
  var w=window.innerWidth||1,dh=document.documentElement.scrollHeight||1;
  post({type:"cursor-tap",x:e.clientX/w,y:(e.clientY+scrollTop())/dh})});
document.addEventListener("mouseleave",function(){post({type:"cursor-leave"})});
window.addEventListener("blur",function(){post({type:"cursor-leave"})});
document.addEventListener("visibilitychange",function(){
  if(document.hidden)post({type:"cursor-leave"})});

/* -- highlight styles (mark's default yellow is overridden) -- */
var st=document.createElement("style");
st.textContent="mark.dock-hl{background:rgba(124,108,189,.20);color:inherit;border-bottom:2px solid rgba(124,108,189,.5);border-radius:2px;cursor:pointer;transition:background .15s,border-color .15s}"+
"mark.dock-hl:hover,mark.dock-hl.dock-hl-on{background:rgba(124,108,189,.42);border-bottom-color:rgba(124,108,189,.95)}"+
/* personal (your private notes) paint amber, so they're obviously distinct from the lavender shared/team highlights */
"mark.dock-hl-personal{background:rgba(224,169,58,.22);border-bottom-color:rgba(224,169,58,.6)}"+
"mark.dock-hl-personal:hover,mark.dock-hl-personal.dock-hl-on{background:rgba(224,169,58,.45);border-bottom-color:rgba(224,169,58,.95)}"+
"mark.dock-hl-flash{animation:dockflash 1s ease 2}"+
"@keyframes dockflash{50%{background:rgba(124,108,189,.7)}}";
(document.head||document.documentElement).appendChild(st);

function textNodes(root){
  var w=document.createTreeWalker(root||document.body,NodeFilter.SHOW_TEXT,{acceptNode:function(n){
    var p=n.parentNode?n.parentNode.nodeName:"";
    return p==="SCRIPT"||p==="STYLE"||p==="NOSCRIPT"?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT}});
  var out=[],n;while((n=w.nextNode()))out.push(n);return out}
function clearMarks(){
  var ms=document.querySelectorAll("mark[data-dock-id]");
  for(var i=0;i<ms.length;i++){var m=ms[i],p=m.parentNode;
    while(m.firstChild)p.insertBefore(m.firstChild,m);
    p.removeChild(m);p.normalize()}}
/* same resolution order as the server: context match first, then exact */
function find(full,a){
  var pre=a.prefix||"",suf=a.suffix||"",ctx=pre+a.exact+suf;
  if(ctx!==a.exact){var i=full.indexOf(ctx);if(i>=0)return i+pre.length}
  return full.indexOf(a.exact)}
/* wrap [s,e) of root's concatenated text in marks; reverse order keeps offsets valid */
function wrapIn(root,id,s,e,personal){
  var nodes=textNodes(root),offs=[],full="";
  for(var i=0;i<nodes.length;i++){offs.push(full.length);full+=nodes[i].nodeValue}
  var segs=[];
  for(var i=0;i<nodes.length;i++){
    var ns=offs[i],ne=ns+nodes[i].nodeValue.length;
    if(ne<=s||ns>=e)continue;
    segs.push({n:nodes[i],a:Math.max(0,s-ns),b:Math.min(nodes[i].nodeValue.length,e-ns)})}
  for(var q=segs.length-1;q>=0;q--){
    var g=segs[q],t=g.n;
    if(g.b<t.nodeValue.length)t.splitText(g.b);
    var mid=g.a>0?t.splitText(g.a):t;
    var mk=document.createElement("mark");
    mk.setAttribute("data-dock-id",id);mk.className=personal?"dock-hl dock-hl-personal":"dock-hl";
    if(personal)mk.setAttribute("data-dock-personal","1");
    mk.title=personal?"Your private note":"View comment";
    t.parentNode.insertBefore(mk,mid);mk.appendChild(mid)}}
/* root's concatenated-text offset for an anchor (context match first, then exact) */
function findIn(root,a){
  var nodes=textNodes(root),full="";
  for(var i=0;i<nodes.length;i++)full+=nodes[i].nodeValue;
  return find(full,a)}
/* deck slides, ordered: explicit [data-dock-slide] (sorted) else .slide in document
   order. Empty on a non-deck artifact — then anchors resolve against the whole doc. */
function slideEls(){
  var ex=document.querySelectorAll("[data-dock-slide]");
  if(ex.length)return [].slice.call(ex).sort(function(a,b){
    return (+a.getAttribute("data-dock-slide"))-(+b.getAttribute("data-dock-slide"))});
  return [].slice.call(document.querySelectorAll(".slide"))}
/* which slide an already-painted anchor landed in (its mark's nearest slide ancestor) */
function slideOf(id,slides){
  var m=document.querySelector('mark[data-dock-id="'+id+'"]');
  for(var s=m;s;s=s.parentElement){var k=slides.indexOf(s);if(k>=0)return k}
  return null}

/* doc-absolute top of each anchor's first highlight — the host pins cards to these */
function reportRects(){
  var tops={},seen={},sy=scrollTop();
  var ms=document.querySelectorAll("mark[data-dock-id]");
  for(var i=0;i<ms.length;i++){var id=ms[i].getAttribute("data-dock-id");
    if(seen[id])continue;seen[id]=1;tops[id]=ms[i].getBoundingClientRect().top+sy}
  post({type:"anchor-rects",tops:tops,scrollY:sy,viewH:window.innerHeight,
    docH:document.documentElement.scrollHeight})}
function reportScroll(){post({type:"scroll",scrollY:scrollTop(),viewH:window.innerHeight,docH:document.documentElement.scrollHeight})}

/* Resolve each anchor, scoping a deck comment to its recorded slide FIRST (so the
   same phrase on two slides can't collide), then falling back to a whole-document
   search if the text has moved off that slide. Reports, per id, whether it resolved
   and which slide it actually landed in (null = outside any slide / non-deck). */
function applyAnchors(anchors){
  clearMarks();
  var slides=slideEls(),resolved={},landed={};
  for(var k=0;k<anchors.length;k++){
    var a=anchors[k],placed=false,where=null;
    if(a.slide!=null&&slides[a.slide]){
      var s1=findIn(slides[a.slide],a);
      if(s1>=0){wrapIn(slides[a.slide],a.id,s1,s1+a.exact.length,a.personal);placed=true;where=a.slide}}
    if(!placed){
      var s2=findIn(document.body,a);
      if(s2>=0){wrapIn(document.body,a.id,s2,s2+a.exact.length,a.personal);placed=true;
        where=slides.length?slideOf(a.id,slides):null}}
    resolved[a.id]=placed;landed[a.id]=where}
  post({type:"anchors-resolved",resolved:resolved,slides:landed});
  reportRects()}

/* live scroll + resize, rAF-throttled so cards glide with the text */
var sTick=0;
window.addEventListener("scroll",function(){if(sTick)return;
  sTick=requestAnimationFrame(function(){sTick=0;reportScroll()})},true);
var rTick=0;
function reflow(){if(rTick)return;rTick=requestAnimationFrame(function(){rTick=0;reportRects()})}
window.addEventListener("resize",reflow);
/* images/fonts settle after load — re-measure a few times so pins land right */
window.addEventListener("load",function(){reportRects();setTimeout(reportRects,400);setTimeout(reportRects,1200)});

/* hover a highlight -> emphasize its card in the host */
document.addEventListener("mouseover",function(e){
  var m=e.target&&e.target.closest?e.target.closest("mark[data-dock-id]"):null;
  if(m)post({type:"anchor-hover",id:m.getAttribute("data-dock-id")})});
document.addEventListener("mouseout",function(e){
  var m=e.target&&e.target.closest?e.target.closest("mark[data-dock-id]"):null;
  if(m)post({type:"anchor-hover",id:null})});
/* clicking a highlight focuses its thread in the host */
document.addEventListener("click",function(e){
  var el=e.target,m=el&&el.closest?el.closest("mark[data-dock-id]"):null;
  if(m){post({type:"anchor-click",id:m.getAttribute("data-dock-id"),personal:m.getAttribute("data-dock-personal")==="1"});return}
  navLink(e)
},true);
/* Cross-document links: a relative <a> the server resolved to a sibling artifact
   (data-dock-nav="<ref>"). The sandboxed frame can't navigate the host, so hand the
   click off for an in-app transition (or a new tab on a modified / middle click —
   the host opens that un-sandboxed). preventDefault stops the frame loading /a/… into
   itself. Only marked links are touched; ordinary and in-page links are untouched. */
function navLink(e){
  var a=e.target&&e.target.closest?e.target.closest("a[data-dock-nav]"):null;
  if(!a)return;
  e.preventDefault();
  post({type:"navigate",ref:a.getAttribute("data-dock-nav"),
    newTab:!!(e.metaKey||e.ctrlKey||e.shiftKey||e.button===1)})}
document.addEventListener("auxclick",function(e){if(e.button===1)navLink(e)},true);

function setOn(id){
  var on=document.querySelectorAll("mark.dock-hl-on");
  for(var i=0;i<on.length;i++)on[i].classList.remove("dock-hl-on");
  if(!id)return;
  var ms=document.querySelectorAll('mark[data-dock-id="'+id+'"]');
  for(var j=0;j<ms.length;j++)ms[j].classList.add("dock-hl-on")}

window.addEventListener("message",function(e){
  var d=e.data;
  if(!d||d.source!=="dock-host")return;
  if(d.type==="anchors")applyAnchors(d.anchors||[]);
  else if(d.type==="remeasure")reportRects();
  else if(d.type==="emphasize")setOn(d.id);
  else if(d.type==="scroll-by")window.scrollBy(0,d.dy||0);
  else if(d.type==="focus-anchor"){
    var ms=document.querySelectorAll('mark[data-dock-id="'+d.id+'"]');
    if(!ms.length)return;
    /* bias (0..1) places the highlight at that fraction of the viewport instead of
       dead-center — phones pass ~0.28 so it lands above the comments sheet. */
    if(typeof d.bias==="number"){var br=ms[0].getBoundingClientRect();
      window.scrollTo({top:scrollTop()+br.top-window.innerHeight*d.bias,behavior:"smooth"})}
    else ms[0].scrollIntoView({behavior:"smooth",block:"center"});
    for(var i=0;i<ms.length;i++){ms[i].classList.remove("dock-hl-flash");void ms[i].offsetWidth;ms[i].classList.add("dock-hl-flash")}
    setTimeout(reportScroll,360)}
});
})();`

/** The tag appended to served artifact HTML; resolves on any host. */
export const SELECTION_SCRIPT = `<script src="/raw/dock-client.js"></script>`

/** True if the comment's stored anchor still resolves in `text`. */
export function isAnchored(anchorJson: string | null, text: string): boolean {
  if (!anchorJson) return true
  try {
    const sel = JSON.parse(anchorJson) as QuoteSelector
    if (sel.type !== "TextQuoteSelector" || !sel.exact) return true
    return reanchor(sel, text).found
  } catch {
    return true
  }
}

/** One thread's anchoring inputs for the re-anchor sweep. `anchor` is the stored
 *  selector JSON of the thread's root comment (null = a whole-document thread). */
export interface AnchorThread {
  thread_id: string
  anchor: string | null
  state: CommentState
}

/** A state flip the sweep wants applied (always thread-level). */
export interface AnchorTransition {
  thread_id: string
  state: "open" | "outdated"
}

/**
 * Decide which threads change state when an artifact is republished. Pure — the
 * caller applies the returned flips.
 *
 * - `open` + anchored + no longer resolves → `outdated` (the quoted text changed)
 * - `outdated` + resolves again            → `open`     (the text came back)
 * - `resolved` threads and whole-document (un-anchored) threads are never touched.
 */
export function planAnchorSweep(threads: AnchorThread[], newText: string): AnchorTransition[] {
  const out: AnchorTransition[] = []
  for (const t of threads) {
    if (!t.anchor) continue // whole-document feedback never goes stale
    const resolves = isAnchored(t.anchor, newText)
    if (t.state === "open" && !resolves) out.push({ thread_id: t.thread_id, state: "outdated" })
    else if (t.state === "outdated" && resolves) out.push({ thread_id: t.thread_id, state: "open" })
  }
  return out
}

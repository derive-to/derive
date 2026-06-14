/** A W3C Web Annotation TextQuoteSelector — survives republishing. */
export interface QuoteSelector {
  type: "TextQuoteSelector"
  exact: string
  prefix?: string
  suffix?: string
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
 *                 anchors-resolved  (which anchor ids matched this document)
 *                 anchor-rects      (doc-absolute top of every painted highlight)
 *                 scroll            (live scroll offset — cards track their text)
 *                 anchor-click      (user clicked a highlight)
 *                 anchor-hover      (pointer entered/left a highlight)
 *                 cursor            (live pointer position for multiplayer cursors)
 *                 cursor-tap        (a click — peers ripple at this point)
 *                 cursor-leave      (pointer left / frame blurred — drop our cursor)
 *  host → frame:  anchors           (paint highlights for these anchors)
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
  if(!t||t.length<2){post({type:"select",selector:null,rect:null});return}
  var ctx=(s.anchorNode&&s.anchorNode.textContent)||t,i=ctx.indexOf(t);
  var rect=null;try{var r=s.getRangeAt(0).getBoundingClientRect();
    if(r&&(r.height||r.width))rect={top:r.top,bottom:r.bottom,left:r.left,right:r.right}}catch(_){}
  post({type:"select",rect:rect,selector:{type:"TextQuoteSelector",exact:t,
    prefix:i>=0?ctx.slice(Math.max(0,i-24),i):"",
    suffix:i>=0?ctx.slice(i+t.length,i+t.length+24):""}})}
document.addEventListener("mouseup",function(){setTimeout(emitSelection,0)});
document.addEventListener("selectionchange",function(){
  var s=window.getSelection();if(!s||s.isCollapsed)post({type:"select",selector:null,rect:null})});

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
"mark.dock-hl-flash{animation:dockflash 1s ease 2}"+
"@keyframes dockflash{50%{background:rgba(124,108,189,.7)}}";
(document.head||document.documentElement).appendChild(st);

function textNodes(){
  var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{acceptNode:function(n){
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
/* wrap [s,e) of the concatenated text in marks; reverse order keeps offsets valid */
function wrap(id,s,e){
  var nodes=textNodes(),offs=[],full="";
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
    mk.setAttribute("data-dock-id",id);mk.className="dock-hl";mk.title="View comment";
    t.parentNode.insertBefore(mk,mid);mk.appendChild(mid)}}

/* doc-absolute top of each anchor's first highlight — the host pins cards to these */
function reportRects(){
  var tops={},seen={},sy=scrollTop();
  var ms=document.querySelectorAll("mark[data-dock-id]");
  for(var i=0;i<ms.length;i++){var id=ms[i].getAttribute("data-dock-id");
    if(seen[id])continue;seen[id]=1;tops[id]=ms[i].getBoundingClientRect().top+sy}
  post({type:"anchor-rects",tops:tops,scrollY:sy,viewH:window.innerHeight,
    docH:document.documentElement.scrollHeight})}
function reportScroll(){post({type:"scroll",scrollY:scrollTop(),viewH:window.innerHeight,docH:document.documentElement.scrollHeight})}

function applyAnchors(anchors){
  clearMarks();
  var res={};
  for(var k=0;k<anchors.length;k++){
    var a=anchors[k];
    /* recompute the text walk per anchor — earlier wraps split text nodes */
    var nodes=textNodes(),full="";
    for(var i=0;i<nodes.length;i++)full+=nodes[i].nodeValue;
    var s=find(full,a);
    res[a.id]=s>=0;
    if(s>=0)wrap(a.id,s,s+a.exact.length)}
  post({type:"anchors-resolved",resolved:res});
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
  if(m)post({type:"anchor-click",id:m.getAttribute("data-dock-id")})
},true);

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
  else if(d.type==="emphasize")setOn(d.id);
  else if(d.type==="scroll-by")window.scrollBy(0,d.dy||0);
  else if(d.type==="focus-anchor"){
    var ms=document.querySelectorAll('mark[data-dock-id="'+d.id+'"]');
    if(!ms.length)return;
    ms[0].scrollIntoView({behavior:"smooth",block:"center"});
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

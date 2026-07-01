import { elementResolvesIn, parseElementSelector } from "./element-anchor"
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
 * Served at /raw/derive-client.js with a SHORT cache and referenced by URL from
 * artifact HTML — the HTML itself is cached immutable, so baking the client
 * inline would freeze old behavior into every previously-viewed artifact.
 */
export const ANCHOR_CLIENT_JS = `(function(){
function post(m){m.source="derive";parent.postMessage(m,"*")}
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
  if(!el||!el.closest||el.closest("a,button,input,textarea,select,label,[data-derive-id]"))return;
  /* touch has no hover, so the desktop chip never appears — a tap on a non-text media
     element (image/chart/video/embed) is how you anchor a comment to it on mobile.
     Text-ish containers (table/pre/figure cells) still fall through to block-tap. */
  var ael=anchorEl(el);
  if(ael&&/^(img|svg|canvas|video|audio|iframe|embed|object|picture)$/.test(ael.tagName.toLowerCase())){
    var er=ael.getBoundingClientRect();tapGuard=Date.now();
    post({type:"select",element:true,rect:{top:er.top,bottom:er.bottom,left:er.left,right:er.right},
      selector:buildElSelector(ael)});return}
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
st.textContent="mark.derive-hl{background:rgba(100,116,139,.20);color:inherit;border-bottom:2px solid rgba(100,116,139,.5);border-radius:2px;cursor:pointer;transition:background .15s,border-color .15s}"+
"mark.derive-hl:hover,mark.derive-hl.derive-hl-on{background:rgba(100,116,139,.42);border-bottom-color:rgba(100,116,139,.95)}"+
/* personal (your private notes) paint amber, so they're obviously distinct from the lavender shared/team highlights */
"mark.derive-hl-personal{background:rgba(224,169,58,.22);border-bottom-color:rgba(224,169,58,.6)}"+
"mark.derive-hl-personal:hover,mark.derive-hl-personal.derive-hl-on{background:rgba(224,169,58,.45);border-bottom-color:rgba(224,169,58,.95)}"+
"mark.derive-hl-flash{animation:derive-flash 1s ease 2}"+
"@keyframes derive-flash{50%{background:rgba(100,116,139,.7)}}"+
/* element overlays: a non-text anchor draws an outline box (pointer-events off so
   the element stays interactive) with a clickable comment badge in its corner. A
   low-confidence relocation reads dashed to signal "we think it moved here". */
".derive-el-hl{position:absolute;pointer-events:none;border:2px solid rgba(100,116,139,.55);border-radius:4px;box-shadow:0 0 0 3px rgba(100,116,139,.12);transition:border-color .15s,box-shadow .15s,opacity .15s;z-index:2147483640}"+
/* low confidence (a relocation we're unsure about) = a quiet hint, never an alarm.
   At rest there's NO box at all — just the small badge with a tiny 'moved' pip. The
   faint dashed outline appears only when you hover the badge, so the document stays
   calm and the signal is opt-in. */
".derive-el-hl.derive-el-low{border-color:transparent;box-shadow:none}"+
".derive-el-hl.derive-el-low:hover,.derive-el-hl.derive-el-low.derive-el-on{border:1px dashed rgba(100,116,139,.5)}"+
".derive-el-hl.derive-el-on{border-color:rgba(100,116,139,.95);box-shadow:0 0 0 4px rgba(100,116,139,.22)}"+
".derive-el-hl.derive-el-flash{animation:derive-el-flash 1s ease 2}"+
"@keyframes derive-el-flash{50%{box-shadow:0 0 0 6px rgba(100,116,139,.4)}}"+
".derive-el-badge{position:absolute;top:-11px;right:-11px;width:22px;height:22px;border-radius:11px;background:rgba(100,116,139,.95);color:#fff;font:600 12px/22px system-ui,sans-serif;text-align:center;pointer-events:auto;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.25)}"+
/* on a moved (low-confidence) badge: dimmed, with a tiny pip marking 'approximate'.
   Brightens on hover so it's findable without being loud. */
".derive-el-low .derive-el-badge{background:rgba(100,116,139,.55);box-shadow:0 1px 3px rgba(0,0,0,.16)}"+
".derive-el-low:hover .derive-el-badge{background:rgba(100,116,139,.95)}"+
".derive-el-pip{position:absolute;bottom:-2px;right:-2px;width:8px;height:8px;border-radius:50%;background:rgba(100,116,139,.85);border:1.5px solid #fff;box-sizing:content-box}"+
/* the hover affordance: a small 'Comment' chip that follows the pointer over an
   anchorable element; clicking it pins a comment to that element. */
".derive-el-chip{position:absolute;display:none;align-items:center;gap:5px;padding:4px 9px;border-radius:7px;background:rgba(100,116,139,.97);color:#fff;font:600 12px/1 system-ui,sans-serif;pointer-events:auto;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.28);z-index:2147483641;white-space:nowrap}"+
".derive-el-outline{position:absolute;display:none;pointer-events:none;border:2px dashed rgba(100,116,139,.6);border-radius:4px;z-index:2147483639}";
(document.head||document.documentElement).appendChild(st);

/* === Element anchors ========================================================
   Pin a comment to a non-text element (image, chart, table, embed, code, figure).
   We capture several independent signals and resolve by agreement — a cascade:
   id -> css -> content fingerprint -> structural ordinal -> geometry -> neighbors.
   fnv/nw/elFp MUST stay byte-identical with element-anchor.ts so a fingerprint
   made here equals one made on the server. */
function fnv(s){var h=0x811c9dc5;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=(h+((h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24)))>>>0}return h.toString(36)}
function nw(s){return (s||"").replace(/\\s+/g," ").trim()}
function elSrc(el){return (el.getAttribute&&(el.getAttribute("src")||el.getAttribute("href")))||""}
function elAlt(el){return (el.getAttribute&&(el.getAttribute("alt")||el.getAttribute("aria-label")||el.getAttribute("title")))||""}
function elText(el){return nw(el.textContent||"")}
/* join separator MUST equal FP_SEP in element-anchor.ts (\\u0001) — joining with ""
   instead silently made browser fingerprints differ from the server's. */
function elFp(el){var tag=el.tagName.toLowerCase();return fnv([tag,elSrc(el),elAlt(el),elText(el).slice(0,120)].join("\\u0001"))}
function elOrdinal(el){var all=document.getElementsByTagName(el.tagName);
  for(var i=0;i<all.length;i++){if(all[i]===el)return i}return 0}
/* nearest preceding/following text block, in document order. Walks OUTWARD from el
   (prev/next siblings, then up a level) instead of scanning every block in the doc —
   the old querySelectorAll+compareDocumentPosition was O(blocks) PER candidate, so a
   large gallery froze the frame for seconds (1500 imgs ~1.7s). The nearest block is
   almost always a sibling or one level up, so this is effectively O(1). */
var BLOCKS="p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,figcaption,dd,dt,pre";
function isBlock(n){return n.nodeType===1&&n.matches&&n.matches(BLOCKS)}
/* deepest block at the trailing (last=true) or leading edge of root's subtree, incl root */
function edgeBlockText(root,last){
  if(root.nodeType!==1)return null;
  var bl=root.querySelectorAll?root.querySelectorAll(BLOCKS):[];
  for(var i=0;i<bl.length;i++){var b=bl[last?bl.length-1-i:i],t=nw(b.textContent||"");if(t.length>=2)return t}
  if(isBlock(root)){var rt=nw(root.textContent||"");if(rt.length>=2)return rt}
  return null}
function neighborText(el){
  var before=null,after=null,hops=0;
  for(var n=el;n&&n.parentElement&&!before&&hops<400;n=n.parentElement)
    for(var s=n.previousElementSibling;s&&!before&&hops<400;s=s.previousElementSibling){hops++;before=edgeBlockText(s,true)}
  hops=0;
  for(var m=el;m&&m.parentElement&&!after&&hops<400;m=m.parentElement)
    for(var p=m.nextElementSibling;p&&!after&&hops<400;p=p.nextElementSibling){hops++;after=edgeBlockText(p,false)}
  return {before:before,after:after}}
/* structural css path of tag:nth-of-type up to a stable ancestor (authored id or body) */
function cssPath(el){var parts=[],n=el;
  for(var depth=0;n&&n.nodeType===1&&depth<8;depth++){
    var tag=n.tagName.toLowerCase();
    if(looksAuthoredId(n.id)){parts.unshift("#"+n.id);break}
    if(tag==="body"){parts.unshift("body");break}
    var k=1;for(var c=n.previousElementSibling;c;c=c.previousElementSibling)if(c.tagName===n.tagName)k++;
    parts.unshift(tag+":nth-of-type("+k+")");n=n.parentNode}
  return parts.join(">")}
function looksAuthoredId(id){return !!id&&!/[0-9a-f]{8}|^[0-9]|^(radix|headlessui|react|mui|:r)/i.test(id)}
var ANCHORABLE="img,picture,svg,canvas,video,audio,iframe,embed,object,table,pre,figure";
function anchorEl(t){
  if(!t||!t.closest)return null;
  if(t.closest("[data-derive-id],.derive-el-chip,.derive-el-badge,a,button,input,textarea,select,label"))return null;
  var el=t.closest(ANCHORABLE);
  if(el)return el;
  var div=t.closest("div,section,figure");
  if(div&&/chart|graph|plot|viz|sparkline/i.test((div.className||"")+" "+(div.id||"")))return div;
  return null}
function roleOf(el){var tag=el.tagName.toLowerCase();
  if(tag==="img"||tag==="picture")return "image";
  if(tag==="video"||tag==="audio")return "media";
  if(tag==="iframe"||tag==="embed"||tag==="object")return "embed";
  if(tag==="table")return "table";if(tag==="pre"||tag==="code")return "code";
  if(tag==="svg"||tag==="canvas")return "chart";if(tag==="figure")return "figure";
  if(/chart|graph|plot|viz|sparkline/i.test((el.className||"")+" "+(el.id||"")))return "chart";
  return "block"}
function hostOf(u){var m=(u||"").match(/^https?:\\/\\/([^/]+)/i);return m?m[1].replace(/^www\\./,""):""}
function trunc(s,n){return s.length>n?s.slice(0,n-1)+"\\u2026":s}
function labelOf(el,role){var alt=nw(elAlt(el)),host=hostOf(elSrc(el));
  if(role==="image")return alt?"Image \\u2014 "+trunc(alt,48):host?"Image \\u2014 "+host:"Image";
  if(role==="chart")return alt?"Chart \\u2014 "+trunc(alt,48):"Chart";
  if(role==="media")return el.tagName.toLowerCase()==="audio"?"Audio":host?"Video \\u2014 "+host:"Video";
  if(role==="embed")return host?"Embedded \\u2014 "+host:"Embedded content";
  if(role==="table")return "Table";if(role==="code")return "Code block";
  if(role==="figure")return alt?"Figure \\u2014 "+trunc(alt,48):"Figure";
  return trunc(elText(el)||el.tagName.toLowerCase(),48)||"Element"}
function buildElSelector(el){
  var tag=el.tagName.toLowerCase(),role=roleOf(el),nb=neighborText(el);
  var r=el.getBoundingClientRect(),dh=document.documentElement.scrollHeight||1;
  var id=looksAuthoredId(el.id)?el.id:undefined;
  var html=(el.outerHTML||"");if(html.length>2000)html=html.slice(0,2000);
  return {type:"ElementSelector",tag:tag,role:role,id:id,css:cssPath(el),
    fingerprint:elFp(el),ordinal:elOrdinal(el),
    docFraction:(r.top+scrollTop())/dh,before:nb.before||undefined,after:nb.after||undefined,
    snapshot:{tag:tag,label:labelOf(el,role),text:trunc(elText(el),300)||undefined,
      src:elSrc(el)||undefined,alt:nw(elAlt(el))||undefined,
      w:Math.round(r.width)||undefined,h:Math.round(r.height)||undefined,html:html}}}

/* -- the in-browser cascade: score every candidate by signal agreement and pick
      the best over threshold (mirrors resolveElement in core) -- */
function textClose(a,b){if(typeof a!=="string"||typeof b!=="string")return false;var x=a.toLowerCase(),y=b.toLowerCase();
  if(x===y)return true;var sh=x.length<y.length?x:y,lo=x.length<y.length?y:x;
  if(sh.length>=8&&lo.indexOf(sh)>=0)return true;
  var w=Math.min(16,sh.length);return w>=8&&lo.slice(0,w)===sh.slice(0,w)}
function scoreEl(el,a,fpM){
  var score=0,max=0,signals=[];
  if(a.id){max+=5;if(el.id===a.id){score+=5;signals.push("id")}}
  max+=5;if(elFp(el)===a.fingerprint){score+=5;signals.push("content")}
  if(a.css){max+=3;if(cssPath(el)===a.css){score+=3;signals.push("css")}}
  /* drop ordinal when content repeats across candidates (same logo per slide) — it's
     the signal an insertion scrambles; let neighbors/geometry pick the instance */
  if(fpM<=1){max+=3;if(el.tagName.toLowerCase()===a.tag){
    if(elOrdinal(el)===a.ordinal){score+=3;signals.push("position")}else score+=1}}
  if(a.before||a.after){var nb=neighborText(el);
    if(a.before){max+=1;if(textClose(a.before,nb.before)){score+=1;signals.push("nb")}}
    if(a.after){max+=1;if(textClose(a.after,nb.after)){score+=1;signals.push("nb")}}}
  max+=1;var r=el.getBoundingClientRect(),dh=document.documentElement.scrollHeight||1;
  var f=(r.top+scrollTop())/dh;score+=1*(1-Math.min(1,Math.abs(f-(a.docFraction||0))));
  return {c:max>0?score/max:0,signals:signals}}
function resolveEl(a){
  var cand=[],seen=[];
  if(a.tag){var bt=document.getElementsByTagName(a.tag);for(var i=0;i<bt.length;i++){cand.push(bt[i]);seen.push(bt[i])}}
  if(a.id){var byId=document.getElementById(a.id);if(byId&&seen.indexOf(byId)<0)cand.push(byId)}
  /* count how many candidates share the recorded fingerprint / id — a strong
     signal matching MANY candidates isn't identifying (a gallery of identical
     thumbnails), so it can't grant high confidence (mirrors core's grade()). */
  var fpM=0,idM=0;
  for(var c=0;c<cand.length;c++){if(elFp(cand[c])===a.fingerprint)fpM++;if(a.id&&cand[c].id===a.id)idM++}
  var best=null,bestEl=null,runnerUp=0;
  for(var j=0;j<cand.length;j++){var s=scoreEl(cand[j],a,fpM);
    if(!best||s.c>best.c){if(best&&best.c>runnerUp)runnerUp=best.c;best=s;bestEl=cand[j]}
    else if(s.c>runnerUp)runnerUp=s.c}
  if(!best||best.c<0.42)return null;
  var g=gradeEl(best.signals,best.c,fpM,idM,best.c-runnerUp);
  return {el:bestEl,confidence:g.c,band:g.band,signals:best.signals}}
function gradeEl(sig,conf,fpM,idM,margin){
  var mId=sig.indexOf("id")>=0,mContent=sig.indexOf("content")>=0,nb=sig.indexOf("nb")>=0;
  var uniq=(mId&&idM===1)||(mContent&&fpM===1);
  var ambig=(mId&&idM>1)||(mContent&&fpM>1);
  /* id and content point at different elements (swapped content) -> never high */
  var conflict=(mId&&!mContent&&fpM>0)||(mContent&&!mId&&idM>0);
  if(ambig&&!uniq&&!nb)return {band:"low",c:Math.min(conf,0.45)};
  if(conflict)return {band:"medium",c:Math.min(conf,0.6)};
  if(uniq&&conf>=0.6&&margin>=0.12)return {band:"high",c:conf};
  if((uniq||nb||sig.indexOf("position")>=0)&&conf>=0.5)return {band:"medium",c:Math.min(conf,0.75)};
  return {band:"low",c:Math.min(conf,0.5)}}

/* overlay registry: each resolved element anchor gets an absolutely-positioned
   outline (in document coords, so it glides with scroll) + a corner badge. */
var elReg=[];
function clearEls(){for(var i=0;i<elReg.length;i++){var o=elReg[i].ov;if(o&&o.parentNode)o.parentNode.removeChild(o)}elReg=[]}
function paintEl(id,el,band){
  var low=band==="low";
  var ov=document.createElement("div");ov.className="derive-el-hl"+(low?" derive-el-low":"");
  ov.setAttribute("data-derive-id",id);
  var badge=document.createElement("div");badge.className="derive-el-badge";badge.setAttribute("data-derive-id",id);
  badge.textContent="\\uD83D\\uDCAC";
  /* a moved (low-confidence) anchor gets a tiny pip + an explanatory title; nothing
     louder. medium/high look like a normal anchored comment. */
  if(low){badge.title="View comment \\u00b7 moved here (approximate)";
    var pip=document.createElement("div");pip.className="derive-el-pip";badge.appendChild(pip)}
  else badge.title="View comment";
  /* multiple comments on the SAME element would stack their badges at the identical
     corner — only the top one is then clickable. Fan each extra badge left so every
     comment's badge stays reachable in the document. */
  var stack=0;for(var s=0;s<elReg.length;s++)if(elReg[s].el===el)stack++;
  if(stack>0)badge.style.right=(-11+stack*24)+"px";   /* fan left, staying over the element */
  ov.appendChild(badge);
  document.body.appendChild(ov);elReg.push({id:id,el:el,ov:ov,clips:clipAncestors(el)})}
/* ancestors that clip their overflow (a scrollable panel, a code block) — captured
   once at paint so the hot positioning path is rect math, not getComputedStyle. The
   overlay lives at the body level and isn't clipped by them, so when the element
   scrolls out of one, WE must hide the overlay or it floats over unrelated content. */
function clipAncestors(el){var out=[];
  for(var p=el.parentElement;p&&p!==document.body&&p!==document.documentElement;p=p.parentElement){
    try{var st=getComputedStyle(p),ov=(st.overflow||"")+(st.overflowX||"")+(st.overflowY||"");
      if(/auto|scroll|hidden|clip/.test(ov))out.push(p)}catch(_c){}}
  return out}
function clippedOut(r,clips){if(!clips)return false;
  for(var i=0;i<clips.length;i++){var c=clips[i].getBoundingClientRect();
    if(r.bottom<=c.top||r.top>=c.bottom||r.right<=c.left||r.left>=c.right)return true}
  return false}
var reTick=0;
function positionEls(){var sy=scrollTop(),sx=window.scrollX||0,detached=false;
  for(var i=0;i<elReg.length;i++){var e=elReg[i];
    /* the artifact's JS may REMOVE+recreate an element (a tab switch, an SPA re-render).
       A detached element isn't just moved — repositioning can't help; we must RESOLVE
       again to re-attach to the replacement. (A merely hidden element stays attached →
       handled by the size check below, no re-resolve.) */
    if(!document.contains(e.el)){detached=true;e.ov.style.display="none";continue}
    var r=e.el.getBoundingClientRect();
    if(!(r.width||r.height)||clippedOut(r,e.clips)){e.ov.style.display="none";continue}
    e.ov.style.display="block";e.ov.style.left=(r.left+sx)+"px";e.ov.style.top=(r.top+sy)+"px";
    e.ov.style.width=r.width+"px";e.ov.style.height=r.height+"px"}
  if(detached&&lastAnchors&&!reTick)reTick=setTimeout(function(){reTick=0;applyAnchors(lastAnchors)},150)}

/* hover affordance: a 'Comment' chip parked at the top-right of the anchorable
   element under the pointer; clicking it pins a comment to that element. */
var chip=null,chipEl=null;
function ensureChip(){if(chip)return chip;
  chip=document.createElement("div");chip.className="derive-el-chip";chip.textContent="\\uD83D\\uDCAC Comment";
  chip.addEventListener("click",function(ev){ev.preventDefault();ev.stopPropagation();
    if(!chipEl)return;var el=chipEl,r=el.getBoundingClientRect();
    /* the host stamps the deck slide onto the selector, same as the text path. */
    post({type:"select",element:true,
      rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},
      selector:buildElSelector(el)})});
  document.body.appendChild(chip);return chip}
function showChip(el){var c=ensureChip(),r=el.getBoundingClientRect();
  chipEl=el;c.style.display="inline-flex";
  c.style.left=(r.right+window.scrollX-Math.min(110,r.width))+"px";
  c.style.top=(r.top+scrollTop()-10)+"px"}
function hideChip(){if(chip){chip.style.display="none"}chipEl=null}
document.addEventListener("mouseover",function(e){
  var el=anchorEl(e.target);if(el)showChip(el)});
document.addEventListener("mouseout",function(e){
  /* keep the chip while the pointer is on the chip itself or still over the element */
  var to=e.relatedTarget;
  if(to&&to.closest&&(to.closest(".derive-el-chip")||anchorEl(to)===chipEl))return;
  if(!anchorEl(e.target))return;hideChip()});

function textNodes(root){
  var w=document.createTreeWalker(root||document.body,NodeFilter.SHOW_TEXT,{acceptNode:function(n){
    var p=n.parentNode?n.parentNode.nodeName:"";
    return p==="SCRIPT"||p==="STYLE"||p==="NOSCRIPT"?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT}});
  var out=[],n;while((n=w.nextNode()))out.push(n);return out}
function clearMarks(){
  var ms=document.querySelectorAll("mark[data-derive-id]");
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
    mk.setAttribute("data-derive-id",id);mk.className=personal?"derive-hl derive-hl-personal":"derive-hl";
    if(personal)mk.setAttribute("data-derive-personal","1");
    mk.title=personal?"Your private note":"View comment";
    t.parentNode.insertBefore(mk,mid);mk.appendChild(mid)}}
/* root's concatenated-text offset for an anchor (context match first, then exact) */
function findIn(root,a){
  var nodes=textNodes(root),full="";
  for(var i=0;i<nodes.length;i++)full+=nodes[i].nodeValue;
  return find(full,a)}
/* deck slides, ordered: explicit [data-derive-slide] (sorted) else .slide in document
   order. Empty on a non-deck artifact — then anchors resolve against the whole doc. */
function slideEls(){
  var ex=document.querySelectorAll("[data-derive-slide]");
  if(ex.length)return [].slice.call(ex).sort(function(a,b){
    return (+a.getAttribute("data-derive-slide"))-(+b.getAttribute("data-derive-slide"))});
  return [].slice.call(document.querySelectorAll(".slide"))}
/* which slide an already-painted anchor landed in (its mark's nearest slide ancestor) */
function slideOf(id,slides){
  var m=document.querySelector('mark[data-derive-id="'+id+'"]');
  return slideOfEl(m,slides)}
/* nearest slide ancestor of a DOM element (for element anchors) */
function slideOfEl(el,slides){
  for(var s=el;s;s=s.parentElement){var k=slides.indexOf(s);if(k>=0)return k}
  return null}

/* doc-absolute top of each anchor — text marks AND element overlays — so the host
   pins each card beside whatever it points at. We DEDUPE the host post: a dynamic
   artifact (a live ticker, a 60fps animation) fires the MutationObserver every frame,
   but if nothing the host cares about actually moved (same tops/scroll/size), posting
   would re-render the comment layout 60fps for nothing. Overlays are still repositioned
   in-frame each call; only the cross-frame message is gated on a real change. */
var lastRects="";
function reportRects(){
  var tops={},seen={},sy=scrollTop();
  var ms=document.querySelectorAll("mark[data-derive-id]");
  for(var i=0;i<ms.length;i++){var id=ms[i].getAttribute("data-derive-id");
    if(seen[id])continue;seen[id]=1;tops[id]=ms[i].getBoundingClientRect().top+sy}
  positionEls();
  for(var j=0;j<elReg.length;j++){var e=elReg[j];if(seen[e.id])continue;
    if(e.ov.style.display==="none")continue;seen[e.id]=1;
    tops[e.id]=e.el.getBoundingClientRect().top+sy}
  var payload={type:"anchor-rects",tops:tops,scrollY:sy,viewH:window.innerHeight,
    docH:document.documentElement.scrollHeight};
  var sig=JSON.stringify(payload);
  if(sig===lastRects)return;        /* nothing the host pins to changed — skip the re-render */
  lastRects=sig;post(payload)}
function reportScroll(){post({type:"scroll",scrollY:scrollTop(),viewH:window.innerHeight,docH:document.documentElement.scrollHeight})}

/* Resolve each anchor, scoping a deck comment to its recorded slide FIRST (so the
   same phrase on two slides can't collide), then falling back to a whole-document
   search if the text has moved off that slide. Reports, per id, whether it resolved
   and which slide it actually landed in (null = outside any slide / non-deck). */
var lastAnchors=null;
function applyAnchors(anchors){
  lastAnchors=anchors;            /* kept so we can re-resolve if an element is replaced */
  clearMarks();clearEls();
  var slides=slideEls(),resolved={},landed={},conf={};
  for(var k=0;k<anchors.length;k++){
    var a=anchors[k];
    /* element anchor: a.el is the stored ElementSelector. Resolve via the cascade,
       paint an outline overlay, and report confidence so the host can flag a
       low-confidence relocation as "moved". */
    if(a.el){
      var m=resolveEl(a.el);
      if(m){paintEl(a.id,m.el,m.band);resolved[a.id]=true;
        landed[a.id]=slides.length?slideOfEl(m.el,slides):null;
        conf[a.id]={confidence:m.confidence,band:m.band,signals:m.signals}}
      else{resolved[a.id]=false;landed[a.id]=a.el.slide!=null?a.el.slide:null}
      continue}
    /* text anchor: scope a deck comment to its recorded slide FIRST (so the same
       phrase on two slides can't collide), then fall back to a whole-document
       search if the text moved off that slide. */
    var placed=false,where=null;
    if(a.slide!=null&&slides[a.slide]){
      var s1=findIn(slides[a.slide],a);
      if(s1>=0){wrapIn(slides[a.slide],a.id,s1,s1+a.exact.length,a.personal);placed=true;where=a.slide}}
    if(!placed){
      var s2=findIn(document.body,a);
      if(s2>=0){wrapIn(document.body,a.id,s2,s2+a.exact.length,a.personal);placed=true;
        where=slides.length?slideOf(a.id,slides):null}}
    resolved[a.id]=placed;landed[a.id]=where}
  post({type:"anchors-resolved",resolved:resolved,slides:landed,conf:conf});
  reportRects()}

/* live scroll + resize, rAF-throttled so cards glide with the text */
var sTick=0;
window.addEventListener("scroll",function(){if(sTick)return;
  sTick=requestAnimationFrame(function(){sTick=0;if(elReg.length)positionEls();reportScroll()})},true);
var rTick=0;
function reflow(){if(rTick)return;rTick=requestAnimationFrame(function(){rTick=0;positionEls();reportRects()})}
window.addEventListener("resize",reflow);
/* element overlays are positioned in document coords, so they glide with scroll;
   but a sub-scroller or a slide flip moves the element under them — reposition on
   scroll too (cheap; same rAF gate as rect reporting via the scroll handler). */
/* images/fonts settle after load — re-measure a few times so pins land right */
window.addEventListener("load",function(){reportRects();setTimeout(reportRects,400);setTimeout(reportRects,1200)});
/* The artifact's OWN scripts can mutate the DOM after load (a chart library renders,
   content animates, an accordion expands) — none of which fire scroll/resize/load. So
   overlays would strand over stale positions. Watch for document size changes
   (ResizeObserver) and DOM edits (MutationObserver) and re-pin. reflow is rAF-gated, so
   a burst of mutations coalesces to one reposition per frame, and the cost is O(anchors)
   not O(DOM). attributes:false so our own style writes in positionEls don't re-trigger it. */
try{if(window.ResizeObserver)new ResizeObserver(reflow).observe(document.documentElement)}catch(_r){}
try{if(window.MutationObserver)new MutationObserver(reflow).observe(document.body||document.documentElement,{childList:true,subtree:true})}catch(_m){}

/* hover a highlight (text mark or element badge) -> emphasize its card in the host */
document.addEventListener("mouseover",function(e){
  var m=e.target&&e.target.closest?e.target.closest("mark[data-derive-id],.derive-el-badge[data-derive-id]"):null;
  if(m)post({type:"anchor-hover",id:m.getAttribute("data-derive-id")})});
document.addEventListener("mouseout",function(e){
  var m=e.target&&e.target.closest?e.target.closest("mark[data-derive-id],.derive-el-badge[data-derive-id]"):null;
  if(m)post({type:"anchor-hover",id:null})});
/* clicking a highlight (text mark or element badge) focuses its thread in the host */
document.addEventListener("click",function(e){
  var el=e.target,m=el&&el.closest?el.closest("mark[data-derive-id],.derive-el-badge[data-derive-id]"):null;
  if(m){post({type:"anchor-click",id:m.getAttribute("data-derive-id"),personal:m.getAttribute("data-derive-personal")==="1"});return}
  navLink(e)
},true);
/* Cross-document links: a relative <a> the server resolved to a sibling artifact
   (data-derive-nav="<ref>"). The sandboxed frame can't navigate the host, so hand the
   click off for an in-app transition (or a new tab on a modified / middle click —
   the host opens that un-sandboxed). preventDefault stops the frame loading /a/… into
   itself. Only marked links are touched; ordinary and in-page links are untouched. */
function navLink(e){
  var a=e.target&&e.target.closest?e.target.closest("a[data-derive-nav]"):null;
  if(!a)return;
  e.preventDefault();
  post({type:"navigate",ref:a.getAttribute("data-derive-nav"),
    newTab:!!(e.metaKey||e.ctrlKey||e.shiftKey||e.button===1)})}
document.addEventListener("auxclick",function(e){if(e.button===1)navLink(e)},true);

function setOn(id){
  var on=document.querySelectorAll("mark.derive-hl-on,.derive-el-hl.derive-el-on");
  for(var i=0;i<on.length;i++){on[i].classList.remove("derive-hl-on");on[i].classList.remove("derive-el-on")}
  if(!id)return;
  var ms=document.querySelectorAll('mark[data-derive-id="'+id+'"]');
  for(var j=0;j<ms.length;j++)ms[j].classList.add("derive-hl-on");
  var ov=document.querySelectorAll('.derive-el-hl[data-derive-id="'+id+'"]');
  for(var q=0;q<ov.length;q++)ov[q].classList.add("derive-el-on")}

window.addEventListener("message",function(e){
  var d=e.data;
  if(!d||d.source!=="derive-host")return;
  if(d.type==="anchors")applyAnchors(d.anchors||[]);
  else if(d.type==="remeasure")reportRects();
  else if(d.type==="emphasize")setOn(d.id);
  else if(d.type==="scroll-by")window.scrollBy(0,d.dy||0);
  else if(d.type==="focus-anchor"){
    /* text marks flash with derive-hl-flash; element overlays with derive-el-flash. */
    var ms=document.querySelectorAll('mark[data-derive-id="'+d.id+'"]');
    var ov=document.querySelectorAll('.derive-el-hl[data-derive-id="'+d.id+'"]');
    var first=ms[0]||ov[0];
    if(!first)return;
    /* bias (0..1) places the target at that fraction of the viewport instead of
       dead-center — phones pass ~0.28 so it lands above the comments sheet. */
    if(typeof d.bias==="number"){var br=first.getBoundingClientRect();
      window.scrollTo({top:scrollTop()+br.top-window.innerHeight*d.bias,behavior:"smooth"})}
    else first.scrollIntoView({behavior:"smooth",block:"center"});
    for(var i=0;i<ms.length;i++){ms[i].classList.remove("derive-hl-flash");void ms[i].offsetWidth;ms[i].classList.add("derive-hl-flash")}
    for(var p=0;p<ov.length;p++){ov[p].classList.remove("derive-el-flash");void ov[p].offsetWidth;ov[p].classList.add("derive-el-flash")}
    setTimeout(reportScroll,360)}
});
})();`

/** The tag appended to served artifact HTML; resolves on any host. */
export const SELECTION_SCRIPT = `<script src="/raw/derive-client.js"></script>`

/** True if the comment's stored anchor still resolves in `content`. For text
 *  anchors `content` is the page text; for element anchors it's the page HTML
 *  (both are the raw decoded file, so one call site covers both). */
export function isAnchored(anchorJson: string | null, content: string): boolean {
  if (!anchorJson) return true
  // Element anchor: relocate via the cascade against the page HTML.
  const el = parseElementSelector(anchorJson)
  if (el) return elementResolvesIn(el, content) !== null
  try {
    const sel = JSON.parse(anchorJson) as QuoteSelector
    if (sel.type !== "TextQuoteSelector" || !sel.exact) return true
    return reanchor(sel, content).found
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

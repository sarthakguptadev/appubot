/**
 * The agent cursor's overlay page (shown by electron/agentCursor.ts; no `electron` import here, so a harness can build
 * it under plain Node). A small pointer in the bot's colours lands exactly on the target (its tip is the hotspot);
 * the bot's own avatar (chat-core botAvatarLook, moved by the app's botAvatar.css) rides beside it and reacts.
 * `window.__cursor` is driven through executeJavaScript, in page coordinates (0,0 = the display's top-left).
 *
 * Layers, outside in. Cursor reactions sit on wrappers of their own (or another CSS property), so they never fight
 * the avatar's mood loops for the same transform:
 *   #w                display → window offset (macOS may shift the overlay)
 *   #pal              the avatar's position: the pointer's glide, LAG ms behind              transform
 *    #side            which side of the tip it rides (flips near the right/bottom edge);     transform (transition);
 *                     stepping aside so the pointer never passes over its face               translate
 *     #pop            appear / hide                                                          transform, opacity
 *      #lean          tilt into travel and settle; scroll nudges; keystroke bounces          rotate, translate
 *       #squash       click squash (ab-bot-boing); grab lean-back; nod                       animation, rotate, scale, translate
 *        .ab-bot[data-mood] > svg > .ab-bot-joy > .ab-bot-body > .ab-bot-tilt > …            botAvatar.css + BOT_MOTION_CSS (mood loops)
 *         .cb-gaze    where the eyes look; squint, blink, widen                              translate, scale
 *          .ab-bot-look > .ab-bot-eye > .ab-bot-pill                                         BOT_MOTION_CSS (the pose's gaze and eyes)
 *   #cur              the pointer's position (tip at 0,0), gliding on a curve; ripples       transform
 *    #tip             appear / hide around the tip; press and hold                            transform, opacity; scale
 * Reduce motion: no loops, wobble, squash or tilt; the glide (it carries information), the ripples and fades stay.
 */
import { BOT_MOTION, botAvatarLook, botPointerInk, characterKey, type BotAvatarLook, type BotFigure, type RoundRect } from '@appubot/chat-core';
import { BOT_MOTION_CSS, BOT_MOTION_VARS } from '../../renderer/src/components/ui/botAvatarMotion';

/** The avatar's size (px) and how far beside the tip it rides. */
const SIZE = 30;
const SIDE = { x: 16, y: 18, flip: -SIZE - 8 };
/** Closer than this to the display's right/bottom edge (px), the avatar rides on the other side. */
const EDGE = 70;
/** The avatar trails the pointer's glide by this much (ms). */
const LAG = 70;
/** The arrow's middle (from its tip), how near it the avatar's centre may pass before it steps aside, and how fast
 *  (px/ms) the step may change once under way. */
const DODGE = { x: 7, y: 11, r: SIZE / 2 + 7, slew: 0.15 };

const attr = (v: string | number) => String(v).replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
const rect = (r: RoundRect, fill: string, cls = '') =>
  `<rect${cls ? ` class="${cls}"` : ''} x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${r.r}" fill="${attr(fill)}"/>`;
const stops = (c: readonly string[], at: readonly number[]) => c.map((s, i) => `<stop offset="${at[i]}" stop-color="${attr(s)}"/>`).join('');

/** The avatar as SVG markup, the same drawing and layers as the app's BotAvatar.tsx (plus .cb-gaze round the eyes). */
function avatarSvg(l: BotAvatarLook): string {
  const g = l.gloss;
  const v = l.visor;
  return `<svg viewBox="0 0 100 100" overflow="visible" class="ab-bot-svg" aria-hidden="true"><defs>`
    + `<linearGradient id="cb-body" x1="0" y1="0" x2="0" y2="1">${stops(l.fill, [0, 0.55, 1])}</linearGradient>`
    + `<linearGradient id="cb-glass" x1="0" y1="0" x2="0" y2="1">${stops(l.glass, [0, 1])}</linearGradient>`
    + `<clipPath id="cb-clip"><path d="${attr(l.body)}"/></clipPath><clipPath id="cb-visor">${rect(v, '#000')}</clipPath></defs>`
    + `<g class="ab-bot-joy"><g class="ab-bot-body"><g class="ab-bot-tilt">`
    + (l.outline ? `<path d="${attr(l.body)}" fill="none" stroke="${attr(l.outline)}" stroke-width="3"/>` : '')
    + `<path d="${attr(l.body)}" fill="url(#cb-body)"/>`
    + `<g clip-path="url(#cb-clip)"><ellipse cx="${g.cx}" cy="${g.cy}" rx="${g.rx}" ry="${g.ry}" transform="rotate(${g.rotate} ${g.cx} ${g.cy})" fill="#fff" opacity="${g.opacity}"/></g>`
    + rect(v, 'url(#cb-glass)')
    + `<g class="cb-gaze"><g class="ab-bot-look">${l.eyes.map((e) => `<g class="ab-bot-eye">${rect(e, l.eye, 'ab-bot-pill').replace('/>', ` style="--ab-rx:${e.r};--ab-ry:${e.h / 2}"/>`)}</g>`).join('')}</g></g>`
    + `<g clip-path="url(#cb-visor)"><rect class="ab-bot-sweep" x="${50 - v.h * 0.25}" y="${v.y - 2}" width="${v.h * 0.5}" height="${v.h + 4}" fill="#fff"/></g>`
    + `</g></g></g></svg>`;
}

/** What the page needs to draw a bot: its avatar's markup, the pointer's gradient (the body's), edge and ripple. */
export interface CursorLook { key: string; fill: readonly [string, string, string]; edge: string; ripple: string; svg: string; seed: number }

export function cursorLook(o: { figure: BotFigure; color: string; seed: number }): CursorLook {
  const l = botAvatarLook(o.figure, o.color);
  return { key: `${typeof o.figure === 'object' ? characterKey(o.figure) : o.figure} ${o.color} ${o.seed}`, fill: l.fill, ...botPointerInk(o.color), svg: avatarSvg(l), seed: o.seed };
}

/* The pointer: an arrow with its tip at (3, 2.3) of its box, so the box sits at (-3, -2) to put the tip on the point. */
const ARROW = 'M3 2.3v17.5c0 .7.8 1 1.3.5l4.3-4.2 2.9 6.6c.2.5.8.7 1.3.5l2.4-1.1c.5-.2.7-.8.5-1.3l-2.9-6.5h6.1c.7 0 1-.8.5-1.3L4.2 1.6C3.7 1.1 3 1.5 3 2.3z';

/** The whole page. `avatarCss` is botAvatar.css (the app's avatar rules), passed in so this stays plain TS; the motion's
 *  keyframes (BOT_MOTION_CSS) come with it. */
export function cursorPage(avatarCss: string): string {
  const vars = Object.entries(BOT_MOTION_VARS).map(([k, v]) => `${k}:${v}`).join(';');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{${vars}}
${avatarCss}
${BOT_MOTION_CSS}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;-webkit-user-select:none}
#w{position:absolute;left:0;top:0}
#cur,#pal{position:absolute;left:0;top:0;will-change:transform}
#tip{position:absolute;left:0;top:0;transform-origin:0 0}
#tip svg{position:absolute;left:-3px;top:-2px;overflow:visible;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
#side{position:absolute;left:0;top:0;width:${SIZE}px;height:${SIZE}px;transform:translate(${SIDE.x}px,${SIDE.y}px);transition:transform .34s cubic-bezier(.23,1,.32,1)}
#pop,#lean,#squash,#bot{width:100%;height:100%;transform-origin:50% 100%}
#pop{transform-origin:50% 50%}
#bot{display:block;filter:drop-shadow(0 2px 3px rgba(0,0,0,.3))}
#bot svg{display:block;width:100%;height:100%}
#w:not(.on) :is(#tip,#pop){opacity:0}
#squash.boing{animation:ab-bot-boing var(--ab-boing) cubic-bezier(.3,.7,.4,1)}
.cb-gaze{transform-box:fill-box;transform-origin:center}
#bot .ab-bot-sweep{opacity:0}
#bot[data-mood='tool'] .ab-bot-sweep{opacity:.16}
#bot[data-look] .ab-bot-sweep{opacity:.16;animation:ab-bot-sweep var(--ab-sweep) ease-in-out both}
.r{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:2px solid var(--col);pointer-events:none}
</style></head><body><div id="w">
<div id="pal"><div id="side"><div id="pop"><div id="lean"><div id="squash"><div id="bot" class="ab-bot" data-mood="rest"></div></div></div></div></div></div>
<div id="cur"><div id="tip"><svg width="24" height="26" viewBox="0 0 24 26"><defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop id="g0" offset="0"/><stop id="g1" offset=".55"/><stop id="g2" offset="1"/></linearGradient></defs><path id="edge" d="${ARROW}" fill="url(#cg)" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg></div></div>
</div><script>
const $=(id)=>document.getElementById(id);
const w=$('w'),cur=$('cur'),tip=$('tip'),pal=$('pal'),side=$('side'),pop=$('pop'),lean=$('lean'),squash=$('squash'),bot=$('bot');
const M=${JSON.stringify(BOT_MOTION)},LAG=${LAG},EDGE=${EDGE},SIDE=${JSON.stringify(SIDE)},HALF=${SIZE / 2},DODGE=${JSON.stringify(DODGE)};
const calm=matchMedia('(prefers-reduced-motion: reduce)');
const soft='cubic-bezier(.45,0,.55,1)',Z='0px 0px';
let ox=0,oy=0,on=false,key='',flipX=false,gaze=null,lookT=0;
/* running animations by owner: the glide (pointer, avatar, tilt, gaze), a held grab, the typing loop, the hide */
let glide=[],held=[],loop=[],outro=[];
const tr=(x,y)=>'translate('+x+'px,'+y+'px)',px=(x,y)=>x.toFixed(2)+'px '+y.toFixed(2)+'px',deg=(a)=>a.toFixed(2)+'deg';
const put=(el,x,y)=>{el.style.transform=tr(x,y)};
/* where an element really is now, mid-animation too */
const at=(el)=>{const m=new DOMMatrix(getComputedStyle(el).transform);return{x:m.e,y:m.f}};
const now=(el,p,d)=>{const v=getComputedStyle(el)[p];return v&&v!=='none'?v:d};
const stop=(list)=>{for(const a of list.splice(0))a.cancel()};
const ease=(t)=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
const eased=(frames,e)=>frames.map((f)=>({easing:e,...f}));
/* the avatar rides below-right of the pointer, or on the other side near the display's right/bottom edge */
const ride=(x,y,jump)=>{flipX=x+ox>innerWidth-EDGE;const flipY=y+oy>innerHeight-EDGE,s={x:flipX?SIDE.flip:SIDE.x,y:flipY?SIDE.flip:SIDE.y};
  if(jump)side.style.transition='none';
  side.style.transform=tr(s.x,s.y);
  if(jump){void side.offsetWidth;side.style.transition=''}
  return s};
/* The avatar trails on the pointer's own path, so a glide toward the side it rides on would carry the pointer over
   its face (once as the pointer pulls away, again as the avatar catches up). Checked at each of the avatar's
   keyframes (where it is then, where the pointer is by then, where its side has slid to), it steps across the
   travel, to whichever side needs less: by the least that clears every check (a hull, so it holds while it trails
   far behind), only ever raised to slide no faster than DODGE.slew, and back in as it lands. */
const along=(pts,f)=>{f=Math.min(20,Math.max(0,f));const i=Math.min(19,Math.floor(f)),p=pts[i],q=pts[i+1];return{x:p.x+(q.x-p.x)*(f-i),y:p.y+(q.y-p.y)*(f-i)}};
const dodge=(pts,ms,ux,uy,s0,s1,d0)=>{const T=ms+LAG+120,t=(i)=>LAG+i/20*ms,R=DODGE.r;let best=null;
  for(const sg of [1,-1]){const n={x:-uy*sg,y:ux*sg},need=pts.map((q,i)=>{const p=along(pts,i+20*LAG/ms),f=Math.min(1,t(i)/340);
      const cx=q.x+s0.x+(s1.x-s0.x)*f+HALF-p.x-DODGE.x,cy=q.y+s0.y+(s1.y-s0.y)*f+HALF-p.y-DODGE.y,al=cx*ux+cy*uy;
      return al*al<R*R?Math.max(0,Math.sqrt(R*R-al*al)-cx*n.x-cy*n.y):0});
    const k=Math.max(...need);if(!best||k<best.k)best={k,need,n}}
  const {k,need,n}=best,top=(a,b)=>Math.max(...need.slice(a,b+1)),hull=need.map((_,i)=>Math.min(top(0,i),top(i,20)));
  if(k<2)return d0===Z?null:side.animate([{translate:d0},{translate:Z}],{duration:240,easing:soft});
  return side.animate([{translate:d0,easing:soft},...hull.map((_,i)=>{const m=Math.max(...hull.map((v,j)=>v-DODGE.slew*Math.abs(i-j)*ms/20));
    return{translate:px(n.x*m,n.y*m),offset:t(i)/T}}),{translate:Z}],{duration:T})};
const render=(l)=>{key=l.key;bot.innerHTML=l.svg;gaze=bot.querySelector('.cb-gaze');bot.style.setProperty('--ab-seed',l.seed);
  $('g0').setAttribute('stop-color',l.fill[0]);$('g1').setAttribute('stop-color',l.fill[1]);$('g2').setAttribute('stop-color',l.fill[2]);
  $('edge').setAttribute('stroke',l.edge);cur.style.setProperty('--col',l.ripple)};
const ripple=(n,dashed)=>{for(let i=0;i<n;i++){const r=document.createElement('div');r.className='r';
  if(dashed)r.style.borderStyle='dashed';cur.appendChild(r);
  r.animate([{transform:'scale(.35)',opacity:.95},{transform:'scale(1.9)',opacity:0}],{duration:520,delay:i*130,easing:'cubic-bezier(.23,1,.32,1)',fill:'both'}).onfinish=()=>r.remove()}};
const press=(n)=>tip.animate(eased(n===2
  ?[{scale:'1'},{scale:'.78',offset:.2},{scale:'1',offset:.34},{scale:'.78',offset:.53},{scale:'1.06',offset:.76},{scale:'1'}]
  :[{scale:'1'},{scale:'.78',offset:.32},{scale:'1.06',offset:.66},{scale:'1'}],'ease-in-out'),{duration:n===2?400:280});
const boing=()=>{squash.classList.remove('boing');void squash.offsetWidth;squash.classList.add('boing')};
squash.addEventListener('animationend',(e)=>{if(e.target===squash)squash.classList.remove('boing')});
const eyes=(frames,ms)=>gaze.animate(eased(frames,'ease-in-out'),{duration:ms});
const glance=(x,y,ms)=>gaze.animate(eased([{translate:Z},{translate:px(x,y),offset:.2},{translate:px(x,y),offset:.75},{translate:Z}],soft),{duration:ms});
const nod=()=>squash.animate(eased([{translate:Z,scale:'1 1'},{translate:'0px 1.5px',scale:'1.03 .92',offset:.35},{translate:'0px -.4px',scale:'.99 1.02',offset:.7},{translate:Z,scale:'1 1'}],'ease-out'),{duration:320});
const blink=()=>eyes([{scale:'1 1'},{scale:'1 .12'},{scale:'1 1'}],M.blink);
/* pop in (scale up with a slight overshoot) / shrink away; a plain fade when motion is reduced */
const pops=(show)=>{const f=show
  ?[{opacity:0,transform:'scale(.6)'},{opacity:1,transform:'scale(1.08)',offset:.6},{opacity:1,transform:'scale(1)'}]
  :[{opacity:1,transform:'scale(1)'},{opacity:0,transform:'scale(.6)'}];
  return calm.matches?f.map(({transform,...k})=>k):f};
window.__cursor={
  origin(x,y){ox=x;oy=y;w.style.transform=tr(x,y)},
  /* a hidden cursor pops in at (sx,sy), the user's pointer; a showing one only changes its look */
  show(l,sx,sy){if(l.key!==key)render(l);bot.dataset.mood='rest';if(on)return;
    on=true;stop(outro);stop(glide);stop(held);stop(loop);delete bot.dataset.still;
    if(sx!==undefined){put(cur,sx,sy);put(pal,sx,sy);ride(sx,sy,true)}
    w.classList.add('on');
    tip.animate(pops(true),{duration:260,easing:'cubic-bezier(.2,.7,.3,1)'});
    pop.animate(pops(true),{duration:260,delay:50,easing:'cubic-bezier(.2,.7,.3,1)',fill:'backwards'})},
  /* glide on a curve from wherever the pointer is now (an interrupted glide goes on from there), the avatar LAG
     behind on the same path, leaning into the travel with its eyes ahead, then settling */
  moveTo(nx,ny,ms){return new Promise((res)=>{
    const a=at(cur),b=at(pal),s0=at(side),d0=now(side,'translate',Z),r0=now(lean,'rotate','0deg'),t0=now(lean,'translate',Z),g0=gaze?now(gaze,'translate',Z):Z;
    stop(glide);put(cur,nx,ny);put(pal,nx,ny);const s1=ride(nx,ny,false);
    const dx=nx-a.x,dy=ny-a.y,d=Math.hypot(dx,dy);
    if(d<1||ms<=0)return res();
    const bend=Math.min(90,d*.2),mx=a.x+dx/2-dy/d*bend,my=a.y+dy/2+dx/d*bend,pts=[];
    for(let i=0;i<=20;i++){const t=ease(i/20),u=1-t;pts.push({x:u*u*a.x+2*u*t*mx+t*t*nx,y:u*u*a.y+2*u*t*my+t*t*ny})}
    const path=pts.map((p)=>tr(p.x,p.y)),ux=dx/d,uy=dy/d,all=ms+LAG,arrow=cur.animate(path.map((transform)=>({transform})),{duration:ms});
    arrow.onfinish=arrow.oncancel=()=>res();
    glide.push(arrow,pal.animate([{transform:tr(b.x,b.y)},...path.map((transform,i)=>({transform,offset:(LAG+i/20*ms)/all}))],{duration:all}));
    const aside=dodge(pts,ms,ux,uy,s0,s1,d0);if(aside)glide.push(aside);
    if(calm.matches||!gaze)return;
    const tilt=ux*8*Math.min(1,d/320),T=all+420,o=(t)=>t/T;
    glide.push(lean.animate(eased([{rotate:r0,translate:t0},{rotate:deg(tilt),translate:Z,offset:o(all*.3)},{rotate:deg(tilt*.7),translate:Z,offset:o(all*.85)},
      {rotate:deg(-tilt*.45),translate:px(ux*2.5,uy*2.5),offset:o(all+110)},{rotate:deg(tilt*.15),translate:px(-ux*.6,-uy*.6),offset:o(all+260)},{rotate:'0deg',translate:Z}],soft),{duration:T}),
      gaze.animate(eased([{translate:g0},{translate:px(ux*4,uy*4),offset:o(all*.25)},{translate:px(ux*4,uy*4),offset:o(all*.85)},{translate:Z,offset:o(all+300)},{translate:Z}],soft),{duration:T}))})},
  react(k){if(!on||!gaze)return;const still=calm.matches;
    if(k==='click'||k==='double'||k==='right'){const n=k==='double'?2:1;ripple(n,k==='right');if(still)return;
      press(n);boing();eyes([{scale:'1 1'},{scale:'1 .45',offset:.35},{scale:'1 1'}],280);if(k==='right')glance(4,0,560);return}
    if(k==='grab'){if(still)return;stop(held);const s=flipX?-1:1;
      held.push(tip.animate([{scale:'1'},{scale:'.85'}],{duration:140,easing:'ease-out',fill:'forwards'}),
        squash.animate([{rotate:'0deg',scale:'1 1'},{rotate:deg(8*s),scale:'.97 1.04'}],{duration:260,easing:'cubic-bezier(.3,.7,.4,1)',fill:'forwards'}));return}
    if(k==='release'){ripple(1,false);const t0=now(tip,'scale','1'),r0=now(squash,'rotate','0deg'),s0=now(squash,'scale','1');stop(held);if(still)return;
      tip.animate(eased([{scale:t0},{scale:'1.08',offset:.45},{scale:'1'}],'ease-out'),{duration:280});
      squash.animate(eased([{rotate:r0,scale:s0},{rotate:deg(flipX?3:-3),scale:'1.03 .97',offset:.45},{rotate:'0deg',scale:'1 1'}],'ease-out'),{duration:380});return}
    if(k.startsWith('scroll-')){if(still)return;const v={up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]}[k.slice(7)]||[0,1],n=px(v[0]*2.5,v[1]*2.5);
      glance(v[0]*4,v[1]*4,800);lean.animate([Z,n,Z,n,Z,n,Z].map((translate)=>({translate,easing:'ease-in-out'})),{duration:600});return}
    if(k==='key'){if(!still){nod();blink()}return}
    if(k==='look'){if(still)return;const s=String(M.eyeSwell);
      eyes([{scale:'1'},{scale:s,offset:.2},{scale:s,offset:.7},{scale:'1'}],900);
      delete bot.dataset.look;void bot.offsetWidth;bot.dataset.look='';clearTimeout(lookT);lookT=setTimeout(()=>{delete bot.dataset.look},M.sweep)}},
  /* typing: keystroke bounces (120ms each) while the eyes read along the line; it ends with a nod */
  activity(k){const g0=gaze&&loop.length?now(gaze,'translate',Z):null;stop(loop);if(!on||!gaze||calm.matches)return;
    if(k==='typing'){const from=now(gaze,'translate',Z);
      loop.push(lean.animate([0,-1.5,0,-1,0,-1.5,0,-.8,0].map((y)=>({translate:'0px '+y+'px'})),{duration:480,iterations:Infinity}),
        gaze.animate([{translate:from},{translate:'-4px 1px'}],{duration:160,easing:'ease-out',fill:'forwards'}),
        gaze.animate(eased([{translate:'-4px 1px'},{translate:'4px 1px',offset:.8},{translate:'-4px 1px'}],soft),{duration:1100,delay:160,iterations:Infinity}));return}
    if(g0){gaze.animate([{translate:g0},{translate:Z}],{duration:200,easing:'ease-out'});nod()}},
  mood(m){bot.dataset.mood=m},
  /* shrink and fade; a glide in flight lands meanwhile. Gone, the avatar's loops stop too: the hidden window stays
     loaded and unthrottled, so they would tick at display rate for as long as the app runs */
  hide(){if(!on)return;on=false;stop(held);stop(loop);w.classList.remove('on');
    outro=[tip.animate(pops(false),{duration:220,easing:'cubic-bezier(.4,0,.7,.2)'}),pop.animate(pops(false),{duration:220,easing:'cubic-bezier(.4,0,.7,.2)'})];
    outro[1].onfinish=()=>{bot.dataset.still=''}}
};
</script></body></html>`;
}

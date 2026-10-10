// FontAlloy prototype regression audit: real-mouse events + elementFromPoint hit
// checks + animation assertions + hover-sweep frame timing.
// Usage: node audit.mjs [baseUrl]  (default http://127.0.0.1:8123)
import {chromium} from 'playwright-core';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const base=process.argv[2]||'http://127.0.0.1:8123';
const shots=join(fileURLToPath(new URL('..',import.meta.url)),'_shots');
mkdirSync(shots,{recursive:true});
const out={errors:[],checks:{}};
const ok=(k,v,extra)=>{out.checks[k]={pass:!!v,...(extra||{})};console.log(`${v?'PASS':'FAIL'} ${k}${extra&&extra.detail?' — '+extra.detail:''}`)};

const browser=await chromium.launch({channel:'chrome',headless:true});
const ctx=await browser.newContext({viewport:{width:1440,height:940}});
const page=await ctx.newPage();
page.on('pageerror',e=>out.errors.push(String(e)));
page.on('console',m=>{if(m.type()==='error'&&!/font|favicon|net::/.test(m.text()))out.errors.push(m.text())});
await page.goto(base+'/index.html',{waitUntil:'load'});
await page.reload({ignoreCache:true});
await page.evaluate(()=>document.fonts.ready);
await page.waitForTimeout(900); // let entrance animations finish

// ---- 1. Zero JS errors on load ----
ok('no-js-errors',out.errors.length===0,{detail:out.errors.join(' | ')||'clean'});

// ---- 2. Old theme-transition killer removed: .qh / .pop transitions restored ----
const trans=await page.evaluate(()=>{
  const g=el=>{const c=getComputedStyle(el);return{prop:c.transitionProperty,dur:c.transitionDuration}};
  return{qh:g(document.querySelector('#wt-q')),pop:g(document.querySelector('#charpop'))}});
ok('qh-transition-restored',trans.qh.prop!=='none'&&trans.qh.dur!=='0s',{detail:`qh ${trans.qh.prop} ${trans.qh.dur}`});
ok('pop-transition-restored',/opacity/.test(trans.pop.prop),{detail:`pop ${trans.pop.prop} ${trans.pop.dur}`});

// ---- 3. Pagination still present (performance guarantee intact) ----
const paged=await page.evaluate(()=>{const p=document.querySelector('.pgc .num');return p?p.textContent:''});
ok('pagination-intact',/第 \d+\/\d+ 页/.test(paged),{detail:paged});

// ---- 4. Real mouse: cell hover = neutral color + scale(1.05) ----
const cellBox=await page.evaluate(()=>{const c=document.querySelector('#grid .cell');const r=c.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,border:getComputedStyle(c).borderColor}});
await page.mouse.move(cellBox.x,cellBox.y);
await page.waitForTimeout(260);
const hoverState=await page.evaluate(([x,y])=>{
  const c=document.elementFromPoint(x,y)?.closest('.cell');if(!c)return null;
  const s=getComputedStyle(c);
  return{transform:s.transform,border:s.borderColor,bg:s.backgroundColor}},[cellBox.x,cellBox.y]);
ok('cell-hover-scale',hoverState&&/1\.0[45]/.test(hoverState.transform),{detail:hoverState?.transform});
ok('cell-hover-neutral',hoverState&&!hoverState.border.startsWith('rgb(15, 118')&&!hoverState.border.includes('15, 118, 110')&&!hoverState.border.includes('74, 222, 158'),{detail:`border ${hoverState?.border}`});

// ---- 5. Real-mouse cell click opens the popup; Escape close has a transition ----
await page.mouse.click(cellBox.x,cellBox.y);
await page.waitForTimeout(250);
const popOpen=await page.evaluate(()=>document.querySelector('#charpop').classList.contains('open'));
ok('charpop-opens-real-click',popOpen);
await page.keyboard.press('Escape');
await page.waitForTimeout(80); // sample mid-transition (180ms exit)
const popExit=await page.evaluate(()=>getComputedStyle(document.querySelector('#charpop')).opacity);
ok('charpop-exit-transition',+popExit>0&&+popExit<1,{detail:`opacity@80ms=${popExit}`});
await page.waitForTimeout(300);

// ---- 6. Theme toggle: .theming flashes on/off; transitions alive afterwards ----
await page.evaluate(()=>{window._cls=[];new MutationObserver(ms=>window._cls.push(...ms.map(m=>m.target.className))).observe(document.documentElement,{attributes:true,attributeFilter:['class']})});
const themeBtn=await page.evaluate(()=>{const r=document.querySelector('[data-themebtn]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});
await page.mouse.click(themeBtn.x,themeBtn.y);
await page.waitForTimeout(420);
const themeInfo=await page.evaluate(()=>({cls:window._cls,dark:document.documentElement.dataset.theme==='dark',qhDur:getComputedStyle(document.querySelector('#wt-q')).transitionDuration}));
ok('theme-flip-dark',themeInfo.dark);
ok('theming-class-flash',themeInfo.cls.some(c=>String(c).includes('theming')),{detail:themeInfo.cls.join(' ; ')});
ok('theme-transitions-alive-after',themeInfo.qhDur!=='0s',{detail:themeInfo.qhDur});
await page.screenshot({path:join(shots,'r30-grid-dark.png')});
await page.mouse.click(themeBtn.x,themeBtn.y); // back to light
await page.waitForTimeout(420);

// ---- 7. Stats num-pop: group reassignment marks changed numbers with .pop ----
await page.mouse.click(cellBox.x,cellBox.y-200);await page.waitForTimeout(100); // dismiss any stray popup
await page.keyboard.press('Escape');await page.waitForTimeout(250);
const ga=await page.evaluate(()=>{const b=document.querySelector('#toolrow [data-ga="base"]');if(!b)return null;const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});
if(ga){await page.mouse.click(ga.x,ga.y);await page.waitForTimeout(60);
  const pops=await page.evaluate(()=>[...document.querySelectorAll('#stat b.pop')].map(b=>b.dataset.k+':'+getComputedStyle(b).animationName));
  ok('stat-num-pop',pops.length>=2&&pops.every(p=>p.includes('num-pop')),{detail:pops.join(', ')||'none'});
  // restore defaults so later screenshots stay clean
  await page.keyboard.press('Control+z');await page.waitForTimeout(200);
}else ok('stat-num-pop',false,{detail:'data-ga button not found'});

// ---- 8. Build-button shimmer visibility ----
const buildBtn=await page.evaluate(()=>{const r=document.querySelector('[data-build]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,w:r.width}});
const shimmerRest=await page.evaluate(()=>getComputedStyle(document.querySelector('[data-build]'),'::after').transform);
await page.mouse.move(buildBtn.x,buildBtn.y);
await page.waitForTimeout(120);
const shimmerRun=await page.evaluate(()=>{const s=getComputedStyle(document.querySelector('[data-build]'),'::after');return{name:s.animationName,transform:s.transform}});
ok('shimmer-animates',shimmerRun.name==='shimmer'&&shimmerRun.transform!==shimmerRest,{detail:`rest=${shimmerRest} run=${shimmerRun.transform}`});
await page.mouse.move(10,10);await page.waitForTimeout(300);

// ---- 9. Scene entrance plays once; typing in the preview input does not replay it ----
const sceneBtn=await page.evaluate(()=>{const b=document.querySelector('#mseg button[data-m="scene"]');const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});
await page.mouse.click(sceneBtn.x,sceneBtn.y);
await page.waitForTimeout(120); // entrance just started
const animEnter=await page.evaluate(()=>getComputedStyle(document.querySelector('.sc')).animationName);
await page.waitForTimeout(800);
await page.screenshot({path:join(shots,'r30-scene-light.png')});
await page.click('#prev-txt');
await page.keyboard.type('永和');
await page.waitForTimeout(120);
const animTyping=await page.evaluate(()=>({name:getComputedStyle(document.querySelector('.sc')).animationName,noIn:document.querySelector('#sc-area').classList.contains('no-in')}));
ok('scene-entrance-once',animEnter==='rise-in'&&animTyping.name==='none'&&animTyping.noIn,{detail:`enter=${animEnter} typing=${animTyping.name} no-in=${animTyping.noIn}`});
// back to the character map
const gridBtn=await page.evaluate(()=>{const b=document.querySelector('#mseg button[data-m="grid"]');const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});
await page.mouse.click(gridBtn.x,gridBtn.y);
await page.waitForTimeout(400);

// ---- 10. elementFromPoint hit scan (r12 filters: hidden pops, scroll-clip boxes) ----
const hits=await page.evaluate(()=>{
  const bad=[];let checked=0;
  const clipped=c=>{ // center must sit inside the nearest clipping scroll box
    let p=c.parentElement;
    while(p){const s=getComputedStyle(p);if(/(auto|scroll|hidden)/.test(s.overflow+s.overflowY)){const r=p.getBoundingClientRect();const b=c.getBoundingClientRect();
      if(b.left<r.left-1||b.right>r.right+1||b.top<r.top-1||b.bottom>r.bottom+1)return false}
    p=p.parentElement}return true};
  const els=[...document.querySelectorAll('button,input,select,[role="button"],.csel')]
    .filter(e=>{const r=e.getBoundingClientRect();if(!r.width||!r.height)return false;
      const inHiddenPop=e.closest('.pop:not(.open)');if(inHiddenPop)return false;
      const st=getComputedStyle(e);return st.visibility!=='hidden'&&st.display!=='none'});
  els.forEach(e=>{const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;
    if(x<0||y<0||x>innerWidth||y>innerHeight)return;
    if(!clipped(e))return; checked++;
    const hit=document.elementFromPoint(x,y);
    if(hit&&hit!==e&&!e.contains(hit)&&!hit.contains(e))bad.push(`${e.tagName}.${e.className.split(' ')[0]}@${Math.round(x)},${Math.round(y)} → hit ${hit.tagName}.${(hit.className||'').toString().split(' ')[0]}`)});
  // sample 60 cells
  const cells=[...document.querySelectorAll('#grid .cell')].filter(c=>clipped(c)).slice(0,60);
  cells.forEach(e=>{const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;checked++;
    const hit=document.elementFromPoint(x,y);
    if(hit&&hit!==e&&!e.contains(hit)&&!hit.contains(e))bad.push(`cell@${Math.round(x)},${Math.round(y)} → hit ${hit.tagName}.${(hit.className||'').toString().split(' ')[0]}`)});
  return{checked,bad}});
ok('hit-scan',hits.bad.length===0,{detail:`${hits.checked} checked; blocked: ${hits.bad.slice(0,6).join(' | ')||'none'}`});

// ---- 11. Hover-sweep frame timing over the 1024-cell grid ----
const perf=await page.evaluate(async()=>{
  const row=document.querySelector('#grid').getBoundingClientRect();
  const y=row.y+30;const deltas=[];let last=performance.now();
  const tick=t=>{deltas.push(t-last);last=t};
  const raf=()=>new Promise(r=>requestAnimationFrame(r));
  // the sweep itself is driven by external mouse.move below
  window.__sweep=async x=>{const h=t=>{deltas.push(t-last);last=t};last=performance.now();
    const loop=()=>{h(performance.now());requestAnimationFrame(loop)};
    requestAnimationFrame(loop);
    for(let i=0;i<30;i++){document.elementFromPoint(x+i*30,y);await new Promise(r=>setTimeout(r,16))}
    window.__stop=true};
  return{y}});
// sweep with the real Playwright mouse while sampling rAF deltas in the page
await page.evaluate(()=>{window.__deltas=[];window.__last=performance.now();
  requestAnimationFrame(function loop(t){window.__deltas.push(t-window.__last);window.__last=t;if(!window.__stop)requestAnimationFrame(loop)})});
await page.mouse.move(200,perf.y);
for(let i=0;i<40;i++){await page.mouse.move(200+i*28,perf.y);await page.waitForTimeout(12)}
await page.evaluate(()=>{window.__stop=true});
const frames=await page.evaluate(()=>window.__deltas);
const slow=frames.filter(d=>d>32).length;
const max=Math.max(...frames.slice(2));
ok('hover-sweep-smooth',slow<=3,{detail:`${frames.length} frames, >32ms: ${slow}, max ${max.toFixed(1)}ms`});

// ---- 12. Full-page light screenshot ----
await page.screenshot({path:join(shots,'r30-grid-light.png')});

// ---- 13. Overlay regression: picker open-state hit (stacking trap) + search no-replay ----
const ctr=async sel=>page.evaluate(s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}},sel);
const hdC=await ctr('#fs-base .hd');
await page.mouse.click(hdC.x,hdC.y);await page.waitForTimeout(300);
const pkHit=await page.evaluate(()=>{
  const pk=document.querySelector('#fs-base .pk');if(!pk)return{inside:false};
  const r=pk.getBoundingClientRect();
  const hit=document.elementFromPoint(r.x+r.width/2,Math.min(r.y+150,r.bottom-30));
  return{inside:pk.contains(hit),display:getComputedStyle(pk).display}});
ok('pk-open-hit-inside',pkHit.inside&&pkHit.display==='flex',{detail:JSON.stringify(pkHit)});
const qC=await page.evaluate(()=>{const r=document.querySelector('#fs-base .pk .q').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});
await page.mouse.click(qC.x,qC.y);
await page.keyboard.type('mo',{delay:60});await page.waitForTimeout(350);
const pkSearch=await page.evaluate(()=>{const q=document.querySelector('#fs-base .pk .q');const pk=document.querySelector('#fs-base .pk');
  return{focus:document.activeElement===q,opacity:getComputedStyle(pk).opacity,rows:pk.querySelectorAll('.fp:not(.fpsys)').length}});
ok('pk-search-no-replay',pkSearch.focus&&pkSearch.opacity==='1'&&pkSearch.rows>0,{detail:JSON.stringify(pkSearch)});

// ---- 14. Overlay exit transitions (picker header toggle / csel / Escape / outside click) ----
await page.mouse.click(hdC.x,hdC.y);
await page.waitForTimeout(60);
const pkClosing=await page.evaluate(()=>{const fs=document.querySelector('#fs-base');const pk=fs.querySelector('.pk');if(!pk)return null;
  const s=getComputedStyle(pk);return{display:s.display,opacity:s.opacity,open:fs.classList.contains('open')}});
ok('pk-close-transition',pkClosing&&pkClosing.display==='flex'&&+pkClosing.opacity>0&&+pkClosing.opacity<1&&!pkClosing.open,{detail:JSON.stringify(pkClosing)});
await page.waitForTimeout(400);
await page.mouse.click(hdC.x,hdC.y);await page.waitForTimeout(250);
await page.keyboard.press('Escape');await page.waitForTimeout(350);
ok('pk-escape-close',await page.evaluate(()=>!document.querySelector('#fs-base').classList.contains('open')));
await page.mouse.click(hdC.x,hdC.y);await page.waitForTimeout(250);
await page.mouse.click(cellBox.x,cellBox.y);await page.waitForTimeout(350);
ok('pk-outside-close',await page.evaluate(()=>!document.querySelector('#fs-base').classList.contains('open')));
await page.keyboard.press('Escape');await page.waitForTimeout(250);
const cbC=await ctr('#wt-borrow .csel');
await page.mouse.click(cbC.x,cbC.y);await page.waitForTimeout(250);
const csOpenHit=await page.evaluate(()=>{const pk=document.querySelector('#wt-borrow .csel-pk');const r=pk.getBoundingClientRect();
  return pk.contains(document.elementFromPoint(r.x+r.width/2,r.y+20))});
await page.mouse.click(cbC.x,cbC.y);await page.waitForTimeout(55);
const csClose=await page.evaluate(()=>{const s=getComputedStyle(document.querySelector('#wt-borrow .csel-pk'));return s.display+'|'+s.opacity});
ok('csel-open-close',csOpenHit&&/block\|0\.[0-9]*[1-9]/.test(csClose),{detail:csClose});
await page.waitForTimeout(250);

// ---- 15. Popups must stay inside the app frame (r31: help popover pierced the bottom) ----
await page.click('#wt-q');await page.waitForTimeout(350);
const helpBounds=await page.evaluate(()=>{
  const app=document.querySelector('#app').getBoundingClientRect();
  const p=document.querySelector('#wtpop');const r=p.getBoundingClientRect();
  return{popBottom:Math.round(r.bottom),appBottom:Math.round(app.bottom),popTop:Math.round(r.top),appTop:Math.round(app.top),
    scrollable:p.scrollHeight>p.clientHeight+1,
    overflowing:r.bottom>app.bottom+.5||r.top<app.top-.5||r.left<app.left-.5||r.right>app.right+.5}});
await page.keyboard.press('Escape');await page.waitForTimeout(250);
ok('help-pop-within-app',!helpBounds.overflowing,{detail:JSON.stringify(helpBounds)});
// the char popup near the bottom row must also stay inside (flip above or cap height)
await page.evaluate(()=>{const g=document.querySelector('.gw');g.scrollTop=g.scrollHeight});
await page.waitForTimeout(150);
const lastCell=await page.evaluate(()=>{const cs=[...document.querySelectorAll('#grid .cell')];const c=cs[cs.length-1];const r=c.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});
await page.mouse.click(lastCell.x,lastCell.y);await page.waitForTimeout(300);
const charBounds=await page.evaluate(()=>{
  const app=document.querySelector('#app').getBoundingClientRect();
  const r=document.querySelector('#charpop').getBoundingClientRect();
  return{overflowing:r.bottom>app.bottom+.5||r.top<app.top-.5}});
ok('charpop-bottom-row-within-app',!charBounds.overflowing,JSON.stringify(charBounds));
await page.keyboard.press('Escape');await page.waitForTimeout(250);

await browser.close();
const fails=Object.values(out.checks).filter(c=>!c.pass).length;
console.log(`\n${fails===0?'ALL PASS':fails+' FAIL'} (${Object.keys(out.checks).length} checks)`);
process.exit(fails?1:0);

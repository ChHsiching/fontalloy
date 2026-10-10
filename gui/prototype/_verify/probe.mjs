// Overlay open-state probe v2 (raw mouse only, no locator.click):
// stacking hit tests / exit transitions / search no-replay / screenshots.
import {chromium} from 'playwright-core';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const shots=join(fileURLToPath(new URL('..',import.meta.url)),'_shots');
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await(await browser.newContext({viewport:{width:1440,height:940}})).newPage();
const errs=[];page.on('pageerror',e=>errs.push(String(e)));
await page.goto('http://127.0.0.1:8123/index.html',{waitUntil:'load'});
await page.reload({ignoreCache:true});
await page.evaluate(()=>document.fonts.ready);
await page.waitForTimeout(900);
const ok=(k,v,d)=>console.log(`${v?'PASS':'FAIL'} ${k}${d?' — '+d:''}`);
const ctr=sel=>page.evaluate(s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}},sel);

// 1. Open the picker: the hit at the panel center must land inside the panel (stacking trap)
const hd=await ctr('#fs-base .hd');
await page.mouse.click(hd.x,hd.y);
await page.waitForTimeout(300);
const pkOpen=await page.evaluate(()=>{
  const pk=document.querySelector('#fs-base .pk');const r=pk.getBoundingClientRect();
  const hit=document.elementFromPoint(r.x+r.width/2,Math.min(r.y+150,r.bottom-30));
  const s=getComputedStyle(pk);
  return{inside:pk.contains(hit),hit:hit?hit.tagName+'.'+(hit.className||'').split(' ')[0]:'none',display:s.display,opacity:s.opacity,bg:s.backgroundColor}});
ok('pk-hit-inside',pkOpen.inside,JSON.stringify(pkOpen));
await page.screenshot({path:join(shots,'r31-pk-open-light.png')});

// 2. Typing in search: input keeps focus, panel does not replay its entrance
const qBox=await page.evaluate(()=>{const r=document.querySelector('#fs-base .pk .q').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});
await page.mouse.click(qBox.x,qBox.y);
await page.keyboard.type('mo',{delay:70});
await page.waitForTimeout(350);
const searchState=await page.evaluate(()=>{
  const q=document.querySelector('#fs-base .pk .q');
  const pk=document.querySelector('#fs-base .pk');
  const rows=[...pk.querySelectorAll('.fp:not(.fpsys)')].length;
  return{focus:document.activeElement===q,opacity:getComputedStyle(pk).opacity,rows}});
ok('pk-search-no-replay',searchState.focus&&searchState.opacity==='1'&&searchState.rows>0&&searchState.rows<80,JSON.stringify(searchState));
await page.screenshot({path:join(shots,'r31-pk-search-light.png')});

// 3. Exit transition: click the header again — at 60ms it should still be fading out;
//    after 500ms the node is removed
await page.mouse.click(hd.x,hd.y);
await page.waitForTimeout(60);
const closing=await page.evaluate(()=>{
  const fs=document.querySelector('#fs-base');const pk=fs.querySelector('.pk');
  if(!pk)return{gone:true};
  const s=getComputedStyle(pk);return{display:s.display,opacity:s.opacity,open:fs.classList.contains('open')}});
ok('pk-close-transition',closing.display==='flex'&&+closing.opacity>0&&+closing.opacity<1&&!closing.open,JSON.stringify(closing));
await page.waitForTimeout(500);
const closed=await page.evaluate(()=>{const pk=document.querySelector('#fs-base .pk');return pk?getComputedStyle(pk).display:'removed'});
ok('pk-close-cleanup',closed==='removed'||closed==='none',closed);

// 4. Escape close + outside-click close
await page.mouse.click(hd.x,hd.y);await page.waitForTimeout(250);
await page.keyboard.press('Escape');await page.waitForTimeout(400);
const escClosed=await page.evaluate(()=>!document.querySelector('#fs-base').classList.contains('open'));
ok('pk-escape-close',escClosed);
await page.mouse.click(hd.x,hd.y);await page.waitForTimeout(250);
const cellC=await ctr('#grid .cell');
await page.mouse.click(cellC.x,cellC.y);await page.waitForTimeout(400);
const outClosed=await page.evaluate(()=>!document.querySelector('#fs-base').classList.contains('open'));
ok('pk-outside-close',outClosed);
await page.keyboard.press('Escape');await page.waitForTimeout(300); // dismiss the char popup that opened

// 5. csel dropdown open/close transition
const cb=await ctr('#wt-borrow .csel');
await page.mouse.click(cb.x,cb.y);await page.waitForTimeout(250);
const csOpen=await page.evaluate(()=>{
  const pk=document.querySelector('#wt-borrow .csel-pk');const r=pk.getBoundingClientRect();
  const hit=document.elementFromPoint(r.x+r.width/2,r.y+20);
  const s=getComputedStyle(pk);return{display:s.display,inside:pk.contains(hit)}});
ok('csel-open-hit',csOpen.display==='block'&&csOpen.inside,JSON.stringify(csOpen));
await page.mouse.click(cb.x,cb.y);
await page.waitForTimeout(55);
const csClose=await page.evaluate(()=>{const s=getComputedStyle(document.querySelector('#wt-borrow .csel-pk'));return s.display+'|'+s.opacity});
ok('csel-close-transition',/block\|0\.[0-9]*[1-9]/.test(csClose),csClose);
await page.waitForTimeout(250);

// 6. Fullscreen close fade (switch to scene mode first — that's where the .zb buttons live)
const sceneBtn=await ctr('#mseg button[data-m="scene"]');
await page.mouse.click(sceneBtn.x,sceneBtn.y);await page.waitForTimeout(900);
const zb=await page.evaluate(()=>{const r=document.querySelector('.sc .zb').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});
await page.mouse.click(zb.x,zb.y);await page.waitForTimeout(350);
await page.keyboard.press('Escape');
await page.waitForTimeout(80);
const zfOut=await page.evaluate(()=>{const zf=document.querySelector('.zf');if(!zf)return{gone:true};const s=getComputedStyle(zf);return{cls:zf.className,opacity:s.opacity}});
ok('zf-close-fade',zfOut.gone||zfOut.cls.includes('out')&&+zfOut.opacity<1&&+zfOut.opacity>0,JSON.stringify(zfOut));
await page.waitForTimeout(300);
const gridBtn=await ctr('#mseg button[data-m="grid"]');
await page.mouse.click(gridBtn.x,gridBtn.y);await page.waitForTimeout(400);

// 7. Dark-theme picker screenshot + char popup + help popover
await page.click('[data-themebtn]');await page.waitForTimeout(420);
await page.mouse.click(hd.x,hd.y);await page.waitForTimeout(350);
const pkDark=await page.evaluate(()=>{
  const pk=document.querySelector('#fs-base .pk');const r=pk.getBoundingClientRect();
  const hit=document.elementFromPoint(r.x+r.width/2,Math.min(r.y+150,r.bottom-30));
  return{inside:pk.contains(hit),bg:getComputedStyle(pk).backgroundColor}});
ok('pk-hit-inside-dark',pkDark.inside,JSON.stringify(pkDark));
await page.screenshot({path:join(shots,'r31-pk-open-dark.png')});
await page.mouse.click(hd.x,hd.y);await page.waitForTimeout(350);
await page.mouse.click(cellC.x,cellC.y);await page.waitForTimeout(300);
await page.screenshot({path:join(shots,'r31-charpop-dark.png')});
await page.keyboard.press('Escape');await page.waitForTimeout(250);
await page.click('#wt-q');await page.waitForTimeout(350);
await page.screenshot({path:join(shots,'r31-help-dark.png')});
await page.keyboard.press('Escape');await page.waitForTimeout(200);

// 8. Verify the second picker (fs-donor) as well
await page.click('[data-themebtn]');await page.waitForTimeout(420);
const hd2=await ctr('#fs-donor .hd');
await page.mouse.click(hd2.x,hd2.y);await page.waitForTimeout(300);
const pk2=await page.evaluate(()=>{
  const pk=document.querySelector('#fs-donor .pk');const r=pk.getBoundingClientRect();
  const hit=document.elementFromPoint(r.x+r.width/2,Math.min(r.y+150,r.bottom-30));
  return{inside:pk.contains(hit),hit:hit?hit.tagName+'.'+(hit.className||'').split(' ')[0]:'none'}});
ok('pk-donor-hit-inside',pk2.inside,JSON.stringify(pk2));
await page.screenshot({path:join(shots,'r31-pk-donor-light.png')});
await page.mouse.click(hd2.x,hd2.y);await page.waitForTimeout(300);

ok('no-js-errors',errs.length===0,errs.join(' | ')||'clean');
await browser.close();
console.log('probe v2 done');

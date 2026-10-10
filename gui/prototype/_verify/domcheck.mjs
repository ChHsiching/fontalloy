// DOM verification of vision findings: syntax-highlight colors, theme button styles,
// placeholder text, dark-theme token contrast.
import {chromium} from 'playwright-core';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await(await browser.newContext({viewport:{width:1440,height:940}})).newPage();
await page.goto('http://127.0.0.1:8123/index.html',{waitUntil:'load'});
await page.reload({ignoreCache:true});
await page.evaluate(()=>document.fonts.ready);
await page.waitForTimeout(900);
await page.click('#mseg button[data-m="scene"]');
await page.waitForTimeout(900);

// 1. Syntax highlighting: capture every string token's text, class, computed color
const syn=await page.evaluate(()=>{
  const code=document.querySelectorAll('#sc-area .code-c .ln');
  const out=[];
  code.forEach((ln,i)=>{if(i>3)return;
    ln.querySelectorAll('span span').forEach(sp=>{
      if(sp.textContent.includes('"')||sp.className)out.push({line:i+1,cls:sp.className,text:sp.textContent.slice(0,22),color:getComputedStyle(sp).color})})});
  return out.filter(o=>o.text.includes('"'))});
console.log('STRING TOKENS:',JSON.stringify(syn,null,1));

// 2. Theme button: computed style at rest + under hover, in both themes
const btn=await page.evaluate(()=>{
  const b=document.querySelector('[data-themebtn]');
  const r=b.getBoundingClientRect();
  const probe=(el)=>{const s=getComputedStyle(el);return{bg:s.backgroundColor,border:s.borderColor,color:s.color}};
  return{rest:probe(b),box:{x:r.x+r.width/2,y:r.y+r.height/2}}});
await page.mouse.move(btn.box.x,btn.box.y);await page.waitForTimeout(150);
const btnHover=await page.evaluate(()=>{const s=getComputedStyle(document.querySelector('[data-themebtn]'));return{bg:s.backgroundColor,border:s.borderColor}});
console.log('THEME BTN light rest:',JSON.stringify(btn.rest),'hover:',JSON.stringify(btnHover));
await page.mouse.move(5,5);
await page.click('[data-themebtn]');await page.waitForTimeout(420);
const btnDark=await page.evaluate(()=>{const s=getComputedStyle(document.querySelector('[data-themebtn]'));return{bg:s.backgroundColor,border:s.borderColor}});
console.log('THEME BTN dark rest:',JSON.stringify(btnDark));

// 3. Placeholder text
const ph=await page.evaluate(()=>({goto:document.querySelector('#goto').placeholder,gr:document.querySelector('#grgoto').placeholder}));
console.log('PLACEHOLDERS:',JSON.stringify(ph));

// 4. Dark-theme --ink3 contrast (hint text)
const ink3=await page.evaluate(()=>{
  const c1=getComputedStyle(document.documentElement).getPropertyValue('--ink3').trim();
  const c2=getComputedStyle(document.documentElement).getPropertyValue('--page').trim();
  return{ink3:c1,page:c2}});
console.log('DARK TOKENS:',JSON.stringify(ink3));
await browser.close();

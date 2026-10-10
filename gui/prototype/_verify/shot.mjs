// Retake the four canonical screenshots in a consistent state:
// mouse parked on neutral ground, preview input empty.
import {chromium} from 'playwright-core';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const shots=join(fileURLToPath(new URL('..',import.meta.url)),'_shots');
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await(await browser.newContext({viewport:{width:1440,height:940}})).newPage();
await page.goto('http://127.0.0.1:8123/index.html',{waitUntil:'load'});
await page.reload({ignoreCache:true});
await page.evaluate(()=>document.fonts.ready);
await page.waitForTimeout(900);
const park=async()=>page.mouse.move(680,935); // neutral spot in the stats bar
await park();
await page.screenshot({path:join(shots,'r30-grid-light.png')});
await page.click('[data-themebtn]');await page.waitForTimeout(450);await park();await page.waitForTimeout(150);
await page.screenshot({path:join(shots,'r30-grid-dark.png')});
await page.click('[data-themebtn]');await page.waitForTimeout(450);
await page.click('#mseg button[data-m="scene"]');await page.waitForTimeout(150);
await page.click('[data-themebtn]');await page.waitForTimeout(450);await park();await page.waitForTimeout(600);
await page.screenshot({path:join(shots,'r30-scene-dark.png')});
await page.click('[data-themebtn]');await page.waitForTimeout(450);await park();await page.waitForTimeout(600);
await page.screenshot({path:join(shots,'r30-scene-light.png')});
await browser.close();
console.log('4 shots retaken');

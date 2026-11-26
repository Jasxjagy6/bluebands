import assert from 'node:assert/strict';
import type { Page } from 'playwright';

/** Measure after the opening transition (and any adjustment inside the scroll pane). */
export async function expectBelow(page:Page,trigger:string,menu:string){
  await page.waitForFunction(({trigger,menu})=>{
    const a=document.querySelector(trigger)?.getBoundingClientRect(),m=document.querySelector(menu)?.getBoundingClientRect();
    return a && m && m.height>0 && m.top>=a.bottom-2 && m.top<=a.bottom+18;
  },{trigger,menu},{timeout:3500});
  const [a,m]=await Promise.all([page.locator(trigger).boundingBox(),page.locator(menu).boundingBox()]);
  assert.ok(a&&m&&m.x>=-1&&m.x+m.width<=page.viewportSize()!.width+1&&m.y+m.height<=page.viewportSize()!.height+1,
    `Dropdown outside the viewport: ${JSON.stringify({trigger:a,menu:m,viewport:page.viewportSize()})}`);
  assert.equal(await page.evaluate(()=>window.scrollY),0);
}

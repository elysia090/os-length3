import {expect,test,type Page} from '@playwright/test';
// Sample a real browser-composited screenshot, not just Canvas backing.
async function screenPixel(page: Page, x: number, y: number): Promise<number[]> {
  const encoded = (await page.screenshot({scale:'css'})).toString('base64');
  return page.evaluate(async ({encoded,x,y}) => {
    const bytes=Uint8Array.from(atob(encoded), c=>c.charCodeAt(0));
    const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
    const sample=document.createElement('canvas');
    sample.width=sample.height=1;
    const ctx=sample.getContext('2d')!;
    try {
      ctx.drawImage(bitmap,Math.floor(x),Math.floor(y),1,1,0,0,1,1);
      return Array.from(ctx.getImageData(0,0,1,1).data);
    } finally { bitmap.close(); }
  }, {encoded,x,y});
}
test('actual Wayland commits into mirror canvas: both camera axes, click redraw, host and guest resize', async ({page})=>{
  await page.goto('/');
  const c=page.locator('canvas'),v=page.locator('#camera'),s=page.locator('#status');
  const pix=(x:number,y:number)=>c.evaluate((canvas,[x,y])=>Array.from((canvas as HTMLCanvasElement)
    .getContext('2d')!.getImageData(x,y,1,1).data),[x,y]);
  await expect(c).toHaveAttribute('data-sequence','1');
  await expect(s).toHaveAttribute('data-wait','input');
  await expect(c).toHaveAttribute('width','32'); await expect(c).toHaveAttribute('height','24');
  const before=await c.boundingBox(); expect(before).not.toBeNull();
  await page.getByRole('button',{name:'Pan right and down'}).click();
  await expect.poll(()=>v.evaluate(el=>[el.scrollLeft,el.scrollTop])).toEqual([48,36]);
  const after=await c.boundingBox(); expect(after).not.toBeNull();
  expect([before!.x-after!.x,before!.y-after!.y]).toEqual([48,36]);
  await expect(c).toHaveAttribute('data-sequence','1');
  const pixel=[10,12] as const;
  expect(await pix(...pixel)).toEqual([38,64,48,255]);
  // Browser CSS coordinates, not device pixels. Read actual pan-adjusted rect.
  const x=after!.x+(pixel[0]+0.5)*after!.width/32,y=after!.y+(pixel[1]+0.5)*after!.height/24;
  expect(await screenPixel(page,x,y)).toEqual([38,64,48,255]);
  await page.mouse.click(x,y);
  await expect(c).toHaveAttribute('data-sequence','2');
  expect(await pix(...pixel)).toEqual([248,61,105,255]);
  await expect.poll(()=>screenPixel(page,x,y)).toEqual([248,61,105,255]);
  await page.getByRole('button',{name:'Resize viewport'}).click();
  await expect(v).toHaveCSS('width','270px');
  await expect(c).toHaveAttribute('data-sequence','2');
  await expect(c).toHaveAttribute('width','32'); await expect(c).toHaveAttribute('height','24');
  await page.getByRole('button',{name:'Resize guest raster'}).click();
  await expect(c).toHaveAttribute('data-sequence','3');
  await expect(c).toHaveAttribute('width','47'); await expect(c).toHaveAttribute('height','19');
  expect(await pix(0,0)).toEqual([18,28,42,255]);
  await page.getByRole('button',{name:'Exit guest'}).click();
  await expect(s).toHaveAttribute('data-phase','closed');
  await expect(s).toHaveText('admission acknowledged');
  await expect(c).toHaveAttribute('data-sequence','3');
  const receipts=page.locator('#protocol');
  await expect(receipts).toContainText('WAYLAND_COMMIT seq=1 size=32x24 configure=1 pointer=0 stride=140');
  await expect(receipts).toContainText('WAYLAND_COMMIT seq=2 size=32x24 configure=1 pointer=3 stride=140');
  await expect(receipts).toContainText('WAYLAND_COMMIT seq=3 size=47x19 configure=5 pointer=3 stride=200');
  await expect(receipts).toContainText('WAYLAND_CLIENT pointer=1 configure=2 frame_done=3 releases=3');
});

test.describe('with explicitly staged static BusyBox', () => {
  test.skip(!process.env.EVERYDAY_SHELL_ELF, 'requires the explicitly staged static BusyBox');
  test('a real guest shell starts on demand and outlives the independent guest display', async ({page}) => {
    const shellRequests: string[] = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/fixture/busybox') shellRequests.push(request.url());
    });
    await page.goto('/');
    const surface = page.locator('canvas'), displayStatus = page.locator('#status');
    const scope = page.getByRole('region', {name: 'Guest shell'});
    const output = scope.getByLabel('Guest shell output'), line = scope.getByRole('textbox', {name: 'Shell command'});
    const shellStatus = scope.getByRole('status');
    await expect(surface).toHaveAttribute('data-sequence', '1');
    await expect(shellStatus).toHaveAttribute('data-phase', 'off');
    expect(shellRequests).toEqual([]);
    await scope.getByRole('button', {name: 'Open guest shell'}).click();
    await expect(shellStatus).toHaveAttribute('data-phase', 'input');
    await expect(output).toContainText('everyday$');
    expect(shellRequests).toHaveLength(1);
    async function command(value: string) { await line.fill(value); await line.press('Enter'); }
    await command("printf 'shell-result=%s\\n' \"$((6*7))\"");
    await expect(output).toContainText('shell-result=42');
    await expect(surface).toHaveAttribute('data-sequence', '1');

    await page.getByRole('button', {name: 'Resize guest raster'}).click();
    await expect(surface).toHaveAttribute('data-sequence', '2');
    await expect(surface).toHaveAttribute('width', '47');
    await expect(shellStatus).toHaveAttribute('data-phase', 'input');
    await page.getByRole('button', {name: 'Exit guest'}).click();
    await expect(displayStatus).toHaveText('admission acknowledged');
    await command("printf 'after-display=%s\\n' \"$((9*9))\"");
    await expect(output).toContainText('after-display=81');
    await command('exit');
    await expect(shellStatus).toHaveText('Shell admission closed');
  });
});

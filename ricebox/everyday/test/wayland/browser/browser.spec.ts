import {randomInt} from 'node:crypto';
import {expect,test,type Page} from '@playwright/test';
// Sample a real browser-composited screenshot, not just Canvas backing.
async function screenRegion(page: Page, x: number, y: number,
    width = 1, height = 1, scale: 'css' | 'device' = 'css'): Promise<number[]> {
  const encoded = (await page.screenshot({scale})).toString('base64');
  return page.evaluate(async ({encoded,x,y,width,height}) => {
    const bytes=Uint8Array.from(atob(encoded), c=>c.charCodeAt(0));
    const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
    const sample=document.createElement('canvas');
    sample.width=width; sample.height=height;
    const ctx=sample.getContext('2d')!;
    try {
      ctx.drawImage(bitmap,Math.floor(x),Math.floor(y),width,height,0,0,width,height);
      return Array.from(ctx.getImageData(0,0,width,height).data);
    } finally { bitmap.close(); }
  }, {encoded,x,y,width,height});
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
  expect(await screenRegion(page,x,y)).toEqual([38,64,48,255]);
  await page.mouse.click(x,y);
  await expect(c).toHaveAttribute('data-sequence','2');
  expect(await pix(...pixel)).toEqual([248,61,105,255]);
  await expect.poll(()=>screenRegion(page,x,y)).toEqual([248,61,105,255]);
  await page.getByRole('button',{name:'Resize viewport'}).click();
  // Native scrollbar gutters change the scrollport, not the camera's border box.
  await expect.poll(async () => {
    const box = await v.boundingBox();
    return box && [box.width,box.height];
  }).toEqual([272,210]); // 270 × 208 plus the 1px borders.
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
  test('close and reopen an actual guest view without restarting the BusyBox shell', async ({page}) => {
    let shellAcquisitions = 0;
    page.context().on('request', request => {
      if (new URL(request.url()).pathname === '/fixture/busybox') shellAcquisitions++;
    });
    await page.goto('/');
    const popup = async (label: string) => {
      const issued = page.waitForEvent('popup');
      await page.getByRole('button', {name: label, exact:true}).click();
      const view = await issued;
      await expect(view).toHaveTitle('Ricebox guest view');
      expect(await view.evaluate(() => window.opener === null)).toBe(true);
      expect(page.isClosed()).toBe(false);
      return view;
    };
    let view = await popup('Open guest view window');
    const surface = () => view.getByLabel('Guest raster');
    const terminal = () => view.getByRole('region', {name: 'Guest shell'});
    const input = () => terminal().getByRole('textbox', {name: 'Shell command'});
    const output = () => terminal().getByLabel('Guest shell output');
    async function command(value: string) {
      await expect(input()).toBeEnabled();
      await input().fill(value);await input().press('Enter');
    }
    await expect(surface()).toHaveAttribute('data-sequence','1');
    await terminal().getByRole('button', {name:'Open guest shell'}).click();
    const nonce = randomInt(1024, 30_000);
    await command(String.raw`unset keeper_nonce; keeper_nonce=${nonce}; printf 'keeper-pid=%s\n' "$$"`);
    await expect(output()).toContainText(/keeper-pid=[1-9][0-9]*/);
    const before = (await output().textContent())!.match(/keeper-pid=([1-9][0-9]*)/)![1]!;
    await view.getByRole('button',{name:'Stop drawing', exact:true}).click();
    await expect(view.locator('#status')).toHaveText('admission acknowledged');
    expect(await surface().evaluate(canvas => {
      const c=canvas as HTMLCanvasElement;
      return Array.from(c.getContext('2d')!.getImageData(0,0,c.width,c.height).data).every(x=>x===0);
    })).toBe(true);
    await view.getByRole('button',{name:'Show drawing',exact:true}).click();
    await expect(surface()).toHaveAttribute('data-sequence','1');
    await view.getByRole('button',{name:'Resize guest raster'}).click();
    await expect(surface()).toHaveAttribute('data-sequence','2');
    await expect(surface()).toHaveAttribute('width','47');
    await view.close(); // Browser window close, not CSS hide.
    expect(view.isClosed()).toBe(true);
    await expect(page.locator('#status')).toHaveText('admission acknowledged');
    view = await popup('Reopen guest view window');
    await expect(view.getByRole('button',{name:'Show drawing',exact:true})).toBeEnabled();
    await expect(output()).not.toContainText('reopened='+(nonce+31));
    await command(String.raw`printf 'reopened=%s same-pid=%s\n' "$((keeper_nonce+31))" "$$"`);
    await expect(output()).toContainText('reopened='+(nonce+31)+' same-pid='+before);
    expect(shellAcquisitions).toBe(1);
    await view.getByRole('button',{name:'Show drawing',exact:true}).click();
    await expect(surface()).toHaveAttribute('data-sequence','1');
    const closed = view.waitForEvent('close');
    await view.getByRole('button',{name:'Close guest view window'}).click();
    await closed;
    await expect(page.locator('#status')).toHaveText('admission acknowledged');
    view=await popup('Reopen guest view window');
    await command(String.raw`printf 'third-view=%s\n' "$((keeper_nonce*2))"`);
    await expect(output()).toContainText('third-view='+nonce*2);
    expect(shellAcquisitions).toBe(1);
    // Navigating this one owned popup ends its view and the drawing, not the keeper.
    await view.getByRole('button',{name:'Show drawing',exact:true}).click();
    await expect(surface()).toHaveAttribute('data-sequence','1');
    await view.goto('about:blank');
    await expect(page.getByRole('button',{name:'Reopen guest view window'})).toBeEnabled();
    await expect(page.locator('#status')).toHaveText('admission acknowledged');
    await view.close();
    await page.getByRole('button',{name:'End guest session'}).click();
    await expect(page.locator('#shell-status')).toHaveText('Shell admission closed');
    await expect(page.getByRole('button',{name:'Reopen guest view window'})).toBeDisabled();
    await expect(page.getByRole('button',{name:'Show drawing',exact:true})).toBeDisabled();
  });

});

test.describe('with actual Wayland ARGB SHM', () => {
  test.skip(!process.env.EVERYDAY_ALPHA_ELF, 'requires the explicitly staged Wayland alpha guest');
  test('the installed surface preserves alpha when the backdrop changes without a guest commit', async ({page}) => {
    await page.goto('/?surface=alpha&over=shell');
    const canvas = page.locator('canvas'), stage = page.locator('#stage');
    const coordinates = [3, 13, 22];
    const backing = [[0,0,0,0], [255,128,64,128], [65,110,225,255]];
    const readBacking = () => canvas.evaluate((el, columns) => columns.map(x =>
      Array.from((el as HTMLCanvasElement).getContext('2d')!.getImageData(x,4,1,1).data)), coordinates);
    await expect(canvas).toHaveAttribute('data-sequence','1');
    await expect(page.locator('#protocol')).toContainText('WAYLAND_ALPHA format=argb8888');
    expect(await readBacking()).toEqual(backing);
    // The opaque control pixel is clipped by the initial native scrollport.
    await page.getByRole('button',{name:'Pan right and down'}).click();
    const rect = await canvas.boundingBox();
    expect(rect).not.toBeNull();
    const points = coordinates.map(x => ({
      x: Math.floor(rect!.x+(x+.5)*rect!.width/32),
      y: Math.floor(rect!.y+4.5*rect!.height/24),
    }));
    expect(await canvas.evaluate((el, points) =>
      points.map(({x,y}) => document.elementFromPoint(x,y) === el), points)).toEqual([true,true,true]);

    for (const rgb of [[40,80,160], [200,30,10]]) {
      await stage.evaluate((el, rgb) => { el.style.backgroundColor = 'rgb(' + rgb.join(',') + ')'; }, rgb);
      const expected = [[...rgb,255], [...rgb.map((back,i) => Math.round((back * 127 + backing[1]![i]! * 128) / 255)),255], backing[2]!];
      for (const [i,{x,y}] of points.entries()) {
        await expect.poll(async () => Math.max(...(await screenRegion(page,x,y)).map((channel,j) =>
          Math.abs(channel-expected[i]![j]!)))).toBeLessThanOrEqual(i === 1 ? 1 : 0);
      }
      expect(await readBacking()).toEqual(backing);
      await expect(canvas).toHaveAttribute('data-sequence','1');
    }

    if (process.env.EVERYDAY_SHELL_ELF) {
      await page.getByRole('button',{name:'Open guest shell'}).click();
      const shell = page.getByRole('region',{name:'Guest shell'});
      await expect(shell.getByRole('status')).toHaveAttribute('data-phase','input');
      const command = shell.getByRole('textbox',{name:'Shell command'});
      await command.fill("printf 'shell-underlay=%s\\n' \"$((7*8))\"");
      await command.press('Enter');
      const transcript=stage.locator('#shell-output');
      await expect(transcript).toContainText('shell-underlay=56');
      // It is the live shell text behind the clear guest strip, not an
      // imitation of a terminal or a captured background in the guest.
      await canvas.scrollIntoViewIfNeeded();
      const at=(await canvas.boundingBox())!;
      const clearWidth=Math.floor(at.width*10/32)-2;
      const capture=async()=>Buffer.from(await screenRegion(page,at.x+1,at.y+1,clearWidth,65));
      const visible=await capture();
      await transcript.evaluate(el => {el.style.visibility='hidden';});
      const hidden=await capture();
      expect(visible.equals(hidden)).toBe(false);
      await transcript.evaluate(el => {el.style.visibility='';});
      await expect(canvas).toHaveAttribute('data-sequence','1');
      expect(await readBacking()).toEqual(backing);
    }
    await page.getByRole('button',{name:'Exit guest'}).click();
    await expect(page.locator('#status')).toHaveText('admission acknowledged');
  });
});

test('floating and pinned camera placement do not move or resize the real guest', async ({page}) => {
  await page.goto('/?camera=floating');
  const pane=page.locator('#camera-pane'), canvas=page.locator('canvas');
  const handle=page.getByRole('button',{name:'Move view'});
  const pin=page.getByRole('button',{name:'Pin position'});
  await expect(canvas).toHaveAttribute('data-sequence','1');
  await expect(pane).toHaveAttribute('data-placement','floating');
  const before=(await pane.boundingBox())!;
  async function drag(dx: number, dy: number) {
    const box=(await handle.boundingBox())!;
    const x=box.x+box.width/2, y=box.y+box.height/2;
    await page.mouse.move(x,y);
    await page.mouse.down();
    await page.mouse.move(x+dx,y+dy,{steps:4});
    await page.mouse.up();
  }
  await drag(80,36);
  const after=(await pane.boundingBox())!;
  expect([after.x-before.x,after.y-before.y]).toEqual([80,36]);
  await expect(canvas).toHaveAttribute('data-sequence','1');
  await expect(canvas).toHaveAttribute('width','32');
  await expect(canvas).toHaveAttribute('height','24');

  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed','true');
  await expect(pane).toHaveAttribute('data-placement','pinned');
  await drag(40,20);
  await handle.press('ArrowLeft');
  expect(await pane.boundingBox()).toEqual(after);
  await expect(canvas).toHaveAttribute('data-sequence','1');
  const image=(await canvas.boundingBox())!;
  await page.mouse.click(image.x+10.5*image.width/32,image.y+12.5*image.height/24);
  await expect(canvas).toHaveAttribute('data-sequence','2');
  const rgba=await canvas.evaluate(el=>Array.from((el as HTMLCanvasElement).getContext('2d')!.getImageData(10,12,1,1).data));
  expect(rgba).toEqual([248,61,105,255]);
});

test('the 1.6 CSS px scrollbar keeps native drag targets and pans only the camera', async ({page}) => {
  await page.goto('/?scrollbars=hairline');
  const camera=page.locator('#camera'), canvas=page.locator('canvas');
  await expect(canvas).toHaveAttribute('data-sequence','1');
  const hairline=()=>camera.evaluate(el=>getComputedStyle(el).getPropertyValue('--camera-scroll-hairline').trim());
  expect(await hairline()).toBe('1.6px');
  expect(await camera.evaluate(el=>{
    const {offsetWidth,offsetHeight,clientWidth,clientHeight}=el as HTMLElement;
    return [offsetWidth-clientWidth-2,offsetHeight-clientHeight-2];
  })).toEqual([24,24]); // Subtract the two 1px borders.
  const {x,y,width,height}=(await camera.boundingBox())!;
  const dpr=await page.evaluate(()=>devicePixelRatio);
  // Sample one cross-section through each compositor-painted thumb. Use
  // device pixels and allow one physical pixel of rounding at either DPR.
  const bands=await Promise.all([
    screenRegion(page,(x+width-25)*dpr,(y+27)*dpr,24*dpr,1,'device'),
    screenRegion(page,(x+27)*dpr,(y+height-25)*dpr,1,24*dpr,'device'),
  ]);
  for (const band of bands) {
    let covered=0;
    for (let i=0;i<band.length;i+=4) covered+=Math.max(0,Math.min(1,(245-band[i]!)/(245-82)));
    expect(covered).toBeGreaterThan(0);
    expect(Math.abs(covered-1.6*dpr)).toBeLessThanOrEqual(1);
  }

  async function drag(x: number, y: number, dx: number, dy: number) {
    await page.mouse.move(x,y);
    await page.mouse.down();
    await page.mouse.move(x+dx,y+dy,{steps:4});
    await page.mouse.up();
  }
  await drag(x+width-7,y+27,0,18); // Deliberately outside the visible ink.
  const offset=()=>camera.evaluate(el=>[el.scrollLeft,el.scrollTop]);
  await expect.poll(async()=> (await offset())[1]).toBeGreaterThan(0);
  expect((await offset())[0]).toBe(0);
  await drag(x+27,y+height-7,18,0);
  await expect.poll(async()=> (await offset())[0]).toBeGreaterThan(0);
  await expect(canvas).toHaveAttribute('data-sequence','1');
  await expect(canvas).toHaveAttribute('width','32');
  await expect(canvas).toHaveAttribute('height','24');

  // Never force custom ink/gutters on a high-contrast system.
  await page.emulateMedia({forcedColors:'active'});
  expect(await hairline()).toBe('');
  const left=(await offset())[0]!;
  await camera.focus();
  await camera.press('ArrowRight');
  await expect.poll(async()=> (await offset())[0]).toBeGreaterThan(left);
  await expect(canvas).toHaveAttribute('data-sequence','1');
});

test('the opt-in terminal draws a real guest screen and sends raw keys and Ctrl-C', async ({page}) => {
  test.skip(!process.env.EVERYDAY_SHELL_ELF, 'requires the explicitly staged static BusyBox');
  const terminalRequests: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/assets/terminal-view-')) terminalRequests.push(request.url());
  });
  await page.goto('/');
  await expect(page.locator('canvas')).toHaveAttribute('data-sequence','1');
  expect(terminalRequests).toEqual([]);

  await page.goto('/?terminal=screen');
  const canvas = page.locator('canvas');
  const shell = page.getByRole('region',{name:'Guest shell'});
  const input = shell.getByRole('textbox',{name:'Shell command'});
  const status = shell.getByRole('status');
  const output = shell.locator('#shell-output');
  const typed = async (command: string) => { await input.fill(command); await input.press('Enter'); };
  await expect(canvas).toHaveAttribute('data-sequence','1');
  await expect(shell).toHaveAttribute('data-terminal','screen');
  expect(terminalRequests.length).toBeGreaterThan(0);
  await shell.getByRole('button',{name:'Open guest shell'}).click();
  await expect(status).toHaveAttribute('data-phase','input');
  await expect(output).toContainText('everyday$');
  const promptMode = (await shell.getAttribute('data-terminal-input'))!;

  await typed("printf '\\033[31mvt-red\\033[0m\\n'");
  await expect(output.locator('span').filter({hasText:'vt-red'})).toHaveCSS('color','rgb(173, 36, 51)');
  await expect(status).toHaveAttribute('data-phase','input');
  await typed("/bin/busybox stty -icanon -echo min 1 time 0; " +
    "printf '\\033[?1049h\\033[H\\033[32mvt-green\\033[0m'; " +
    "byte=$(/bin/busybox dd bs=1 count=1 2>/dev/null); /bin/busybox stty icanon echo; " +
    "printf '\\033[?1049l<read:%s>\\n' \"$byte\"; " +
    "IFS= read -r cooked; printf '<line:%s>\\n' \"$cooked\"");
  await expect(shell).toHaveAttribute('data-terminal-input','raw');
  await expect(output).toHaveAttribute('data-screen','alternate');
  await expect(output.locator('span').filter({hasText:'vt-green'})).toHaveCSS('color','rgb(35, 107, 67)');
  await input.press('q');
  await expect(output).toHaveAttribute('data-screen','primary');
  await expect(output).toContainText('<read:q>');
  // The compound command holds a real cooked read. At the next prompt,
  // BusyBox's own line editor may legitimately request raw mode again.
  await expect(shell).toHaveAttribute('data-terminal-input','line');
  await expect(status).toHaveAttribute('data-phase','input');
  await typed('cooked-answer');
  await expect(output).toContainText('<line:cooked-answer>');
  await expect(status).toHaveAttribute('data-phase','input');
  await expect(shell).toHaveAttribute('data-terminal-input',promptMode);

  await typed("/bin/busybox stty -echo; printf '<h%s>\\n' ush; IFS= read -r value; " +
    "/bin/busybox stty echo; printf '<length:%s>\\n' \"${#value}\"");
  await expect(output).toContainText('<hush>');
  await expect(status).toHaveAttribute('data-wait','input');
  const hiddenInput = shell.locator('input[type=password]');
  await hiddenInput.fill('hidden-value');
  await hiddenInput.press('Enter');
  await expect(output).toContainText('<length:12>');
  await expect(output).not.toContainText('hidden-value');
  await expect(status).toHaveAttribute('data-phase','input');

  await typed("/bin/busybox stty -echo; printf '<m%s>\\n' asked; /bin/busybox sleep 2; " +
    "/bin/busybox stty echo; printf '<r%s>\\n' estored");
  await expect(output).toContainText('<masked>');
  await expect(status).toHaveAttribute('data-wait','time');
  await hiddenInput.fill('unsent-masked-draft');
  await expect(output).toContainText('<restored>');
  await expect(input).toHaveValue('');
  await expect(output).not.toContainText('unsent-masked-draft');
  await expect(status).toHaveAttribute('data-phase','input');

  await typed("printf '<s%s>\\n' leep; /bin/busybox sleep 30");
  await expect(output).toContainText('<sleep>');
  await expect(status).toHaveAttribute('data-wait','time');
  expect(await input.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'C', ctrlKey: true, shiftKey: true, cancelable: true,
  })))).toBe(true);
  await input.press('Control+c');
  await expect(status).toHaveAttribute('data-phase','input');
  await expect(shell).toHaveAttribute('data-terminal-input',promptMode);
  await input.pressSequentially("printf '<after:%s>\\n' \"$((6*7))\"");
  await input.press('Enter');
  await expect(output).toContainText('<after:42>');
  await expect(status).toHaveAttribute('data-phase','input');
  await expect(canvas).toHaveAttribute('data-sequence','1');
  await typed("printf '<f%s>\\n' inal; exit");
  await expect(status).toHaveText('Shell admission closed');
  await expect(output).toContainText('<final>');
  await expect(input).toBeDisabled();
  await expect(canvas).toHaveAttribute('data-sequence','1');
});

test('an unavailable optional terminal chunk does not start the shell or block the display', async ({page}) => {
  test.skip(!process.env.EVERYDAY_SHELL_ELF, 'requires the explicitly staged static BusyBox');
  let shellFetches = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/fixture/busybox') shellFetches++;
  });
  await page.route('**/assets/terminal-view-*.js', route => route.abort());
  await page.goto('/?terminal=screen');
  await expect(page.locator('canvas')).toHaveAttribute('data-sequence','1');
  const shell = page.getByRole('region',{name:'Guest shell'});
  await expect(shell.getByRole('status')).toHaveText('Terminal view unavailable; the line console is available.');
  expect(shellFetches).toBe(0);
  await expect(shell.locator('pre#shell-output')).toBeAttached();
  await shell.getByRole('button',{name:'Open guest shell'}).click();
  await expect(shell.locator('#shell-output')).toContainText('everyday$');
  expect(shellFetches).toBe(1);
});

test('blocked popup leaves the in-page drawing and an explicit recovery path', async ({page}) => {
  await page.addInitScript(() => {window.open = () => null;});
  await page.goto('/');
  const open=page.getByRole('button',{name:'Open guest view window'});
  test.skip(!process.env.EVERYDAY_SHELL_ELF,'requires the explicitly staged static BusyBox');
  await open.click();
  await expect(page.locator('#view-status')).toContainText('browser blocked the popup');
  await expect(open).toBeEnabled();
  await expect(page.getByLabel('Guest raster')).toHaveAttribute('data-sequence','1');
});

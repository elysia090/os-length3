import {expect, test} from './fixtures.ts';

for (const width of [390, 500, 760, 1180]) {
  test(`Prompt and pane switch have separate hit areas at ${width}px`, async ({app}) => {
    await app.newRepo.make('prompt-controls');
    await app.newRepo.openInForge();
    await app.page.setViewportSize({width, height: 740});
    const stand = app.page.locator('.desk-term.stand');
    const toggle = app.forge.paneSwitch;
    const apart = async () => {
      const p = (await stand.boundingBox())!, t = (await toggle.boundingBox())!;
      expect(p.x + p.width <= t.x || t.x + t.width <= p.x || p.y + p.height <= t.y || t.y + t.height <= p.y).toBe(true);
    };
    await apart();
    // The mode change uses the real Prompt and produces no shell dependency.
    await app.forge.promptBox.click();
    await app.forge.promptBox.press('Alt+3');
    await app.forge.promptBox.fill('Keep this unfinished note');
    for (let i = 0; i < 3; i++) {
      const before = await toggle.getAttribute('aria-expanded');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', before === 'true' ? 'false' : 'true');
      await expect(app.forge.promptBox).toHaveValue('Keep this unfinished note');
      await apart();
      if (width <= 760 && before === 'false') {
        await expect(app.page.locator('.desk-bench > .side')).toHaveCSS('display', 'grid');
        expect(await app.page.locator('.desk-bench > .side').evaluate(el => getComputedStyle(el, '::before').display)).toBe('none');
      }
    }
    await toggle.focus();
    const before = await toggle.getAttribute('aria-expanded');
    await toggle.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', before === 'true' ? 'false' : 'true');
    await expect(app.forge.promptBox).toHaveValue('Keep this unfinished note');
    await apart();
    await app.page.screenshot({path: `tests/app/.results/prompt-pane-${width}.png`});
    await app.forge.search.focus();
    const search = (await app.forge.search.boundingBox())!, switchAt = (await toggle.boundingBox())!;
    expect(search.x + search.width).toBeLessThanOrEqual(switchAt.x);
    await app.page.screenshot({path: `tests/app/.results/prompt-search-${width}.png`});
    await toggle.focus();
    await expect(app.forge.band.getByRole('button', {name:'prompt-controls', exact:true})).toBeVisible();
  });
}

for (const width of [390, 500, 760]) {
  test(`closing failed Prompt leaves pane unchanged at ${width}px`, async ({app}) => {
    await app.page.route('**/webroot/**', route => route.abort());
    await app.newRepo.make('failed-prompt');
    await app.newRepo.openInForge();
    await app.page.setViewportSize({width, height: 740});
    const stand = app.page.locator('.desk-term.stand');
    const toggle = app.forge.paneSwitch;
    await app.forge.promptBox.fill('echo test');
    const close = stand.getByRole('button', {name: 'Close Prompt'});
    await expect(close).toBeVisible();
    for (let i = 0; i < 2; i++) {
      const before = await toggle.getAttribute('aria-expanded');
      const at = (await close.boundingBox())!;
      await app.page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
      await expect(stand).not.toHaveClass(/\bup\b/);
      await expect(toggle).toHaveAttribute('aria-expanded', before!);
      await toggle.click();
      await app.forge.tools.getByRole('button', {name:'Terminal', exact:true}).click();
      await expect(close).toBeVisible();
    }
    await app.page.screenshot({path: `tests/app/.results/prompt-failure-${width}.png`});
  });
}

// The real shell's output and exit lifecycle, alongside the deterministic failed-start coverage above.
// CI supplies the pinned web root and runs @slow; an explicitly requested run must not silently skip it.
test.describe('narrow Prompt with a running shell', {tag: '@slow'}, () => {
  test.skip(!process.env.SELFTEST_SLOW, '@slow: SELFTEST_SLOW=1 runs it');
  for (const width of [390, 500, 760]) {
    test(`output, Close and exit leave pane state intact at ${width}px`, async ({app}) => {
      test.setTimeout(300_000);
      await app.newRepo.make('running-prompt');
      await app.newRepo.openInForge();
      await app.page.setViewportSize({width, height: 740});
      await app.forge.startPrompt('running-prompt');
      const stand = app.page.locator('.desk-term.stand');
      const toggle = app.forge.paneSwitch;
      const output = stand.locator('.term-out');
      const close = stand.getByRole('button', {name: 'Close Prompt'});
      const tool = app.forge.tools.getByRole('button', {name: 'Terminal', exact: true});
      await app.forge.run('printf "first-line\\nsecond-line\\n"');
      await expect(output).toContainText(/^second-line$/m);
      for (let i = 0; i < 2; i++) {
        const before = await toggle.getAttribute('aria-expanded');
        const at = (await close.boundingBox())!;
        await app.page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
        await expect(stand).not.toHaveClass(/\bup\b/);
        await expect(toggle).toHaveAttribute('aria-expanded', before!);
        await tool.click();
        await expect(output).toContainText(/^second-line$/m);
        await toggle.click();
        await expect(output).toContainText(/^second-line$/m);
      }
      await app.page.screenshot({path: `tests/app/.results/prompt-output-${width}.png`});
      // Ordinary presses outside the overlaid pane still dismiss it; only the explicit
      // Close Prompt action is isolated from that behavior.
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      await app.forge.editor('README.md').click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      const beforeExit = await toggle.getAttribute('aria-expanded');
      await app.forge.run('exit');
      await expect(stand).not.toHaveClass(/\bup\b/);
      await expect(toggle).toHaveAttribute('aria-expanded', beforeExit!);
      await expect(app.forge.promptBox).toBeVisible();
      await tool.click();
      await app.forge.run('echo restarted');
      await expect(output).toContainText(/^restarted$/m);
      await expect(toggle).toHaveAttribute('aria-expanded', beforeExit!);
    });
  }
});

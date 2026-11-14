import {expect, test} from './fixtures.ts';

// Read in the person's favour (docs/DESIGN.md §7): what a hand does is a little off what it meant. The frame's
// squares are pressed from the window's very edge and from half the room between two of them; a press that just
// misses a menu is still the menu's.

test('a pointer against the window\'s edges is on the frame: the rail from the left, the band from the top, the person\'s menu in the corner', async ({app}) => {
  for (const size of [{width: 1440, height: 900}, {width: 390, height: 844}]) {
    await app.page.setViewportSize(size);
    await app.rail.go('home');
    const at = (x: number, y: number) => app.page.evaluate(([x, y]) => {
      const b = document.elementFromPoint(x, y)?.closest('button');
      return b ? (b.id || b.className).split(' ')[0] : null;
    }, [x, y]);
    const what = `at ${size.width}×${size.height}`;
    expect(await at(0, 24), `${what}: the window's left edge beside the first place`).toBe('purpose-home');
    expect(await at(24, 0), `${what}: the window's top over the first place`).toBe('purpose-home');
    // Between two places each has its half of the room: none of it is nobody's.
    expect([await at(24, 45), await at(24, 51)], `${what}: between the first place and the second`).toEqual(['purpose-home', 'purpose-forge']);
    expect(await at(0, size.height - 1), `${what}: the window's bottom left corner`).toBe('me');
    expect(await at(72, 0), `${what}: the window's top over the door`).toBe('door');
    expect(await at(120, 0), `${what}: the window's top over the band's first key`).toBe('band-tool');
  }
});

test('a press just off the person\'s menu leaves it out; one well clear of it puts it away', async ({app}) => {
  await app.me.openMenu();
  const menu = app.page.getByRole('menu', {name: 'Me'});
  const box = (await menu.boundingBox())!;
  await app.page.mouse.click(box.x + box.width + 10, box.y + 40);
  await expect(menu).toBeVisible();
  await app.page.mouse.click(box.x + box.width + 40, box.y + 40);
  await expect(menu).toBeHidden();
});

import {expect, test} from './fixtures.ts';

// Read in the person's favour (why/docs/DESIGN.md §7): what a hand does is a little off what it meant. The frame's
// squares are pressed from the window's very edge and from half the room between two of them; a press that just
// misses a menu is still the menu's.

test('the corner keys take presses at their edges; the rail, door and band still reach the window edge', async ({app}) => {
  const {page} = app;
  for (const size of [{width: 1440, height: 900}, {width: 390, height: 844}]) {
    await page.setViewportSize(size);
    await app.rail.go('home');
    const at = (x: number, y: number) => page.evaluate(([x, y]) => {
      const b = document.elementFromPoint(x, y)?.closest('button');
      return b ? (b.id || b.className).split(' ')[0] : null;
    }, [x, y]);
    const what = `at ${size.width}×${size.height}`;
    await expect(page.getByRole('navigation', {name: 'Purposes', includeHidden: true})).toBeHidden();
    await expect(app.rail.door).toBeHidden();
    // The labelled Places and Search each take the edges of their 44 px targets, on opposite sides.
    const key = (await app.forge.placesKey.boundingBox())!;
    const search = (await app.main.getByRole('button', {name: 'Search', exact: true}).boundingBox())!;
    expect([key.height, search.height]).toEqual([44, 44]);
    expect([await at(key.x + 1, key.y + 1), await at(search.x + search.width - 1, search.y + 1)], what)
      .toEqual(['forge-places-key', 'forge-search-key']);
    await page.mouse.click(key.x + 1, key.y + 1);
    await expect(app.forge.places).toBeVisible();

    // Remote is still a framed sheet: exercise the same edge and slop targets where they are drawn.
    await app.rail.go('remote');
    expect(await at(0, 24), `${what}: the window's left edge beside the first place`).toBe('purpose-home');
    expect(await at(24, 0), `${what}: the window's top over the first place`).toBe('purpose-home');
    expect([await at(24, 45), await at(24, 51)], `${what}: between the first place and the second`).toEqual(['purpose-home', 'purpose-forge']);
    expect(await at(0, size.height - 1), `${what}: the window's bottom left corner`).toBe('me');
    expect(await at(72, 0), `${what}: the window's top over the door`).toBe('door');
    await app.rail.door.click();
    await expect(page.locator('#page')).toHaveAttribute('data-place', 'home');

    // New repo shares the named corners instead of using the old tool band.
    await app.rail.go('new-repo');
    await expect(app.forge.placesKey).toHaveAccessibleName('New repo');
    const creation = (await app.forge.placesKey.boundingBox())!;
    const find = (await app.main.getByRole('button', {name: 'Search', exact: true}).boundingBox())!;
    expect([creation.height, find.height]).toEqual([44, 44]);
    expect([await at(creation.x + 1, creation.y + 1), await at(find.x + find.width - 1, find.y + 1)], what)
      .toEqual(['forge-places-key', 'forge-search-key']);
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

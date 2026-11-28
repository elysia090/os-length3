import {expect, test} from './fixtures.ts';

test('a cancelled Places press does not swallow the next Enter or Space activation', async ({app}) => {
  const at = (place: string) => expect(app.main).toHaveAttribute('data-place', place);
  for (const key of ['Enter', 'Space']) {
    await app.rail.go('runtime');
    await app.forge.placesKey.press('Enter');
    const places = app.forge.places;
    const server = places.getByRole('menuitemradio', {name: 'Server', exact: true});
    await server.focus();
    await expect(server).toBeFocused();

    // A Places row commits on click, not on pointerdown. Cancellation never completes that activation.
    await server.evaluate((b) => {
      const pointer = {bubbles: true, pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0};
      b.dispatchEvent(new PointerEvent('pointerdown', {...pointer, buttons: 1}));
      b.dispatchEvent(new PointerEvent('pointercancel', pointer));
    });
    await at('runtime');
    await expect(places).toBeVisible();
    await expect(server).toBeFocused();

    // Native keyboard activation must still open the named target, not the current page or another menu row.
    await app.page.keyboard.press(key);
    await at('server');
    await expect(places).toBeHidden();
  }
});

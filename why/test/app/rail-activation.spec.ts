import {expect, test} from './fixtures.ts';

test('a cancelled Places press does not swallow the next Enter or Space activation', async ({app}) => {
  const at = (place: string) => expect(app.main).toHaveAttribute('data-place', place);
  await app.rail.go('runtime');
  for (const key of ['Enter', 'Space']) {
    const server = await app.rail.destination('server');
    await expect(server).toBeVisible();
    // A mouse command goes on its down, so it may leave the menu before the platform cancels the pointer.
    await server.evaluate((b) => {
      const pointer = {bubbles: true, pointerType: 'mouse', pointerId: 1, button: 0};
      b.dispatchEvent(new PointerEvent('pointerdown', pointer));
      b.dispatchEvent(new PointerEvent('pointercancel', pointer));
    });
    await at('server');
    await app.rail.go('runtime');
    // Use the actual entry again. Enter and Space are native keyboard activations, not manufactured clicks.
    await (await app.rail.destination('server')).press(key);
    await at('server');
    await app.rail.go('runtime');
  }
});

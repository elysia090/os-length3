import {expect, test} from './fixtures.ts';

test.use({reducedMotion: 'reduce'});

test('buttons confirm once with Enter sound, including keyboard activation; movement and disabled buttons stay silent', async ({app}) => {
  await app.page.evaluate(() => {
    const heard: string[] = [];
    Object.assign(window, {heard});
    window.addEventListener('why-key', (event) => heard.push((event as CustomEvent<string>).detail));
    // Nested content is common in icon buttons. Use native controls so Enter and Space are real activations.
    const box = document.createElement('div');
    box.id = 'sound-test';
    box.style.cssText = 'position:fixed;top:10px;left:10px;z-index:2147483647;background:white';
    box.innerHTML = '<button id="sound-enabled"><span>Sound test</span></button><button disabled id="sound-disabled">Disabled</button><button aria-disabled="true" id="sound-aria-disabled">Unavailable</button><input aria-label="Sound field">';
    document.body.append(box);
  });
  const count = () => app.page.evaluate(() => (window as unknown as {heard: string[]}).heard);
  const button = app.page.locator('#sound-enabled');
  await button.hover();
  await button.focus();
  await app.page.keyboard.press('Tab');
  expect(await count()).toEqual([]);
  await button.locator('span').click();
  expect(await count()).toEqual(['enter']);
  await button.focus();
  await app.page.keyboard.press('Enter');
  expect(await count()).toEqual(['enter', 'enter']);
  await app.page.keyboard.press('Space');
  expect(await count()).toEqual(['enter', 'enter', 'enter']);
  await app.page.locator('#sound-disabled').click({force: true});
  await app.page.locator('#sound-aria-disabled').click({force: true});
  await app.page.getByRole('textbox', {name: 'Sound field'}).fill('quiet');
  await button.evaluate((el: HTMLButtonElement) => el.click());
  expect(await count()).toEqual(['enter', 'enter', 'enter']);
  await app.page.locator('#sound-test').evaluate((el) => el.remove());
});

test('a control pressed with the mouse sounds as it goes down, once, not at the click that ends the press', async ({app}) => {
  await app.page.evaluate(() => {
    const heard: string[] = [];
    Object.assign(window, {heard});
    window.addEventListener('why-key', (event) => heard.push((event as CustomEvent<string>).detail));
    const box = document.createElement('div');
    box.id = 'sound-test';
    box.style.cssText = 'position:fixed;top:10px;left:10px;z-index:2147483647;background:white';
    box.innerHTML = '<button id="sound-enabled"><span>Sound test</span></button>';
    document.body.append(box);
  });
  const heard = () => app.page.evaluate(() => (window as unknown as {heard: string[]}).heard);
  const at = (await app.page.locator('#sound-enabled').boundingBox())!;
  await app.page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await app.page.mouse.down();
  // Heard as the control goes down, while it is still held.
  expect(await heard()).toEqual(['enter']);
  await app.page.mouse.up();
  // Its click is the same activation: not heard again.
  expect(await heard()).toEqual(['enter']);
  // The keys after it still sound their own activation.
  await app.page.locator('#sound-enabled').focus();
  await app.page.keyboard.press('Enter');
  expect(await heard()).toEqual(['enter', 'enter']);
  await app.page.locator('#sound-test').evaluate((el) => el.remove());
});

test('what is typed sounds as it is struck: a letter, Backspace, Tab and Enter a key as any other, Space the space bar; a key held sounds once, a command not at all, and Enter that presses a form\'s button is one stroke', async ({app}) => {
  await app.page.evaluate(() => {
    const heard: string[] = [];
    Object.assign(window, {heard});
    window.addEventListener('why-key', (event) => heard.push((event as CustomEvent<string>).detail));
    const box = document.createElement('form');
    box.id = 'sound-test';
    box.style.cssText = 'position:fixed;top:10px;left:10px;z-index:2147483647;background:white';
    box.innerHTML = '<input aria-label="Sound field"><textarea aria-label="Sound text"></textarea><button id="sound-send">Send</button>';
    box.addEventListener('submit', (event) => event.preventDefault());
    document.body.append(box);
  });
  const heard = () => app.page.evaluate(() => (window as unknown as {heard: string[]}).heard);
  const clear = () => app.page.evaluate(() => { (window as unknown as {heard: string[]}).heard.length = 0; });
  const text = app.page.getByRole('textbox', {name: 'Sound text'}), field = app.page.getByRole('textbox', {name: 'Sound field'});
  // Each stroke once, as its key: letters and Backspace are keys as any other.
  await text.focus();
  await app.page.keyboard.type('ab c');
  await app.page.keyboard.press('Backspace');
  await app.page.keyboard.press('Tab');
  expect(await heard()).toEqual(['key', 'key', 'space', 'key', 'key', 'key']);
  // Enter in a text is a key as any other.
  await clear();
  await text.focus();
  await app.page.keyboard.press('Enter');
  expect(await heard()).toEqual(['key']);
  // A key held is struck once; a command (Ctrl and a key) and a key that writes nothing (an arrow, Escape) are silent.
  await clear();
  await app.page.keyboard.down('x');
  await app.page.keyboard.down('x');
  await app.page.keyboard.down('x');
  await app.page.keyboard.up('x');
  await app.page.keyboard.press('Control+a');
  await app.page.keyboard.press('ArrowLeft');
  await app.page.keyboard.press('Escape');
  expect(await heard()).toEqual(['key']);
  // Enter in a form's field presses its button: one stroke heard, not two.
  await clear();
  await field.focus();
  await app.page.keyboard.type('hi');
  await app.page.keyboard.press('Enter');
  expect(await heard()).toEqual(['key', 'key', 'key']);
  // Out of any text, a letter is not typing.
  await clear();
  await app.page.locator('#sound-send').focus();
  await app.page.keyboard.press('q');
  expect(await heard()).toEqual([]);
  await app.page.locator('#sound-test').evaluate((el) => el.remove());
});

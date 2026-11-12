import {expect, test} from './fixtures.ts';

test.use({reducedMotion: 'reduce'});

test('buttons confirm once with Enter sound, including keyboard activation; movement and disabled buttons stay silent', async ({app}) => {
  await app.page.evaluate(() => {
    const heard: string[] = [];
    Object.assign(window, {heard});
    window.addEventListener('root3-key', (event) => heard.push((event as CustomEvent<string>).detail));
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

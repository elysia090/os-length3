import {expect, test} from './fixtures.ts';

// Temporary visual audit for #195. The same live DOM is compared before and after
// removing only this PR's narrow CSS additions, not against a different app state.
for (const width of [390, 400, 500]) test(`single repo baseline comparison at ${width}px`, async ({app}) => {
  await app.newRepo.make('running-prompt');
  await app.newRepo.openInForge();
  await app.page.setViewportSize({width, height: 740});
  const name = app.forge.band.locator('.pill-name');
  const measure = () => name.evaluate(el => ({width: el.getBoundingClientRect().width, scrollWidth: el.scrollWidth, text: el.textContent}));
  const candidate = await measure();
  await app.page.screenshot({path: `tests/app/.results/band-candidate-${width}.png`});
  const removed = await app.page.evaluate(() => {
    let count = 0;
    for (const sheet of Array.from(document.styleSheets)) {
      for (const outer of Array.from(sheet.cssRules)) {
        if (!(outer instanceof CSSMediaRule) || !/max-width:\s*(560|760)px/.test(outer.conditionText)) continue;
        for (let i = outer.cssRules.length - 1; i >= 0; i--) {
          const rule = outer.cssRules[i];
          if (!(rule instanceof CSSStyleRule)) continue;
          // All seven selectors are new in #195 inside these two media queries.
          if (rule.selectorText.includes('.work.bench.desk-bench') || rule.selectorText === '.desk-bench .band-tools > .search-box') {
            outer.deleteRule(i); count++;
          }
        }
      }
    }
    return count;
  });
  expect(removed).toBe(7);
  const baseline = await measure();
  await app.page.screenshot({path: `tests/app/.results/band-baseline-css-${width}.png`});
  console.log('BAND_COMPARE', JSON.stringify({width, candidate, baseline}));
});

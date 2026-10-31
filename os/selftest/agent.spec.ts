import type {Page} from '@playwright/test';
import {expect, test} from './fixtures.ts';

// The box's Agent: an API key given in Runtime's Agent (beside the dotfiles, apart from them) brings it among what the
// box does; asked there, the question goes into the right pane and the answer comes in under it, the Prompt never up.
// The maker is played here (its key's form is Anthropic's): its list of models, a ping, an answer as server-sent events.

test.use({storageState: async ({helloC}, use) => { await use(helloC); }});

const KEY = `sk-ant-api03-${'Zq7'.repeat(30)}a9fAA`;
const CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*'};

/** The maker, played: what each question was told is kept in `told`. */
async function maker(page: Page, told: string[]) {
  await page.route('https://api.anthropic.com/**', async (route) => {
    const r = route.request();
    if (r.method() === 'OPTIONS') return route.fulfill({status: 204, headers: CORS});
    if (r.url().endsWith('/models')) return route.fulfill({headers: CORS, json: {data: [{id: 'model-one', created_at: '2025-01-01T00:00:00Z'}]}});
    const body = r.postDataJSON() as {stream?: boolean; system?: string};
    if (!body.stream) return route.fulfill({headers: CORS, json: {content: [{type: 'text', text: 'Ready'}]}});
    told.push(body.system ?? '');
    const words = ['Run ', 'it so:\n\n', '```sh\nmake\n```\n'];
    return route.fulfill({headers: {...CORS, 'content-type': 'text/event-stream'},
      body: words.map((text) => `data: ${JSON.stringify({type: 'content_block_delta', delta: {text}})}\n\n`).join('')});
  });
}

test('a key given in Runtime opens the box\'s Agent: asked, it answers in the pane, the Prompt never up; taken away, the box runs', async ({app}) => {
  const told: string[] = [];
  await maker(app.page, told);
  await app.runtime.open('Agent');
  await app.main.getByRole('textbox', {name: 'API key'}).fill(KEY);
  await app.main.getByRole('button', {name: 'Use', exact: true}).click();
  // Shown by its start and last four, never whole; the model it opens beside.
  await expect(app.main.locator('.agent-line')).toContainText('sk-ant-…9fAA');
  await expect(app.main.locator('.agent-line')).toContainText('model-one');

  await app.rail.go('forge');
  const box = app.forge.promptBox, pill = app.main.getByRole('button', {name: /^Input box action/});
  await box.click();
  await box.press('Alt+5');
  await expect(pill).toHaveAccessibleName('Input box action: Ask');
  await expect(pill.locator('.prompt-mode')).toHaveText('Agent@hello');
  await box.fill('How is it built?');
  await box.press('Control+Enter');
  await expect(box).toHaveValue('');
  const flow = app.page.locator('.work.bench:not([hidden]) .term-out');
  await expect(flow.getByRole('button', {name: 'Agent How is it built?'})).toBeVisible();
  await expect(flow.locator('.term-answer')).toContainText('Run it so:');
  await expect(flow.locator('.term-answer .answer-code')).toHaveText('make');
  // Told the repo and the file in front, and asked without the Prompt coming up for it.
  expect(told[0]).toContain('"hello"');
  expect(told[0]).toContain('The file in front of the person: README.md');
  await expect(app.page.locator('.work.bench.prompting')).toHaveCount(0);

  await app.runtime.open('Agent');
  await app.main.getByRole('button', {name: 'Remove', exact: true}).click();
  await expect(app.main.getByRole('textbox', {name: 'API key'})).toBeVisible();
  await app.rail.go('forge');
  await expect(pill).toHaveAccessibleName('Input box action: Run');
  await pill.click();
  await expect(app.main.getByRole('menuitemradio', {name: /Ask Agent/})).toHaveCount(0);
  await expect(app.main.getByRole('menuitemradio')).toHaveCount(4);
});

test.describe('signed in', () => {
  test.use({storageState: undefined});
test('the box\'s Agent says what it does as an agent\'s hooks do: at work on an issue, its box in Git says so', async ({signedIn: app}) => {
  await maker(app.page, []);
  await app.newRepo.make('hello');
  await app.runtime.open('Agent');
  await app.main.getByRole('textbox', {name: 'API key'}).fill(KEY);
  await app.main.getByRole('button', {name: 'Use', exact: true}).click();
  await expect(app.main.locator('.agent-line')).toContainText('model-one');
  // The repo on the issue's work: what the Agent is asked there is the issue's line's.
  await app.git.write('hello', 'Docs: How to build');
  await app.git.step('Start').click();
  await expect(app.git.step('Back to main')).toBeVisible();
  await app.rail.go('forge');
  const box = app.forge.promptBox;
  await box.click();
  await box.press('Alt+5');
  await box.fill('How is it built?');
  await box.press('Control+Enter');
  await expect(app.page.locator('.work.bench:not([hidden]) .term-answer .answer-code')).toHaveText('make');
  await app.rail.go('git');
  // Its turn over, it is as any agent whose turn is over: by name, its last words, waiting on the person.
  const row = app.main.locator('.agent-row');
  await expect(row).toContainText('Agent');
  await expect(row).toContainText('Run it so:');
  await expect(row).toHaveClass(/waits/);
});
});

import type {Page} from '@playwright/test';
import {expect, personName, test} from './fixtures.ts';

// The Agent: an API key given in Runtime's Agent (beside the dotfiles, apart from them), and `agent` and what to do run
// in the terminal on Forge's desk: the line is the person's, run there; the Agent's own terminal is born beside it, and
// what it does and says comes there, played at a person's pace, the person's terminal left to them. The maker is played here (its key's form is Anthropic's): its list of models, a
// ping, and each turn of its model's as `turns` says it (the conversation so far in, its next words and tools out).

test.use({storageState: async ({helloC}, use) => { await use(helloC); }});

const KEY = `sk-ant-api03-${'Zq7'.repeat(30)}a9fAA`;
const CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*'};

interface Asked { system?: string; tools?: {name: string}[]; messages: {role: string; content: unknown}[] }
type Block = {type: 'text'; text: string} | {type: 'tool_use'; id: string; name: string; input: Record<string, unknown>};

/** The maker, played: what each piece of work was told is kept in `told`; `turns` gives the model's next turn. */
async function maker(page: Page, told: string[], turns: (asked: Asked) => Block[]) {
  await page.route('https://api.anthropic.com/**', async (route) => {
    const r = route.request();
    if (r.method() === 'OPTIONS') return route.fulfill({status: 204, headers: CORS});
    if (r.url().endsWith('/models')) return route.fulfill({headers: CORS, json: {data: [{id: 'model-one', created_at: '2025-01-01T00:00:00Z'}]}});
    const asked = r.postDataJSON() as Asked;
    // The ping that finds the model the key opens: no tools offered.
    if (!asked.tools) return route.fulfill({headers: CORS, json: {content: [{type: 'text', text: 'Ready'}]}});
    if (asked.messages.length === 1) told.push(asked.system ?? '');
    const content = turns(asked);
    return route.fulfill({headers: CORS, json: {content, stop_reason: content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn'}});
  });
}

/** What the last tool given back said, in the conversation so far. */
const given = (asked: Asked) => ((asked.messages.at(-1)?.content as {content?: string}[] | undefined)?.[0]?.content ?? '');

test('a key given in Runtime: `agent` run in the terminal is asked of the Agent, whose own terminal is born beside it; taken away, the line says so', async ({app}) => {
  const told: string[] = [];
  await maker(app.page, told, () => [{type: 'text', text: 'Run it so:\n\n```sh\nmake\n```\n'}]);
  await app.runtime.open('Agent');
  await app.main.getByRole('textbox', {name: 'API key'}).fill(KEY);
  await app.main.getByRole('button', {name: 'Use', exact: true}).click();
  // Shown by its start and last four, never whole; the model it opens beside.
  await expect(app.main.locator('.agent-line')).toContainText('sk-ant-…9fAA');
  await expect(app.main.locator('.agent-line')).toContainText('model-one');

  await app.rail.go('forge');
  const box = app.forge.promptBox;
  await box.focus();
  await box.fill('agent How is it built?');
  await box.press('Enter');
  // The line is the person's: run in their terminal, the box empty for the next at once.
  await expect(box).toHaveValue('');
  await expect(app.forge.prompt.locator('.term-out')).toContainText('agent How is it built?');
  // The Agent's terminal, beside the person's on the desk: what it was asked, then its words.
  const agent = app.main.getByRole('region', {name: 'Agent', exact: true});
  await expect(agent.locator('.agent-asked')).toHaveText('How is it built?');
  await expect(agent.locator('.agent-words')).toContainText('Run it so:');
  await expect(agent.locator('.agent-words .answer-code')).toHaveText('make');
  const term = (await app.main.locator('.desk-box[data-key="term"]').boundingBox())!;
  const beside = (await app.main.locator('.desk-box[data-key="agent"]').boundingBox())!;
  expect(beside.x).toBeGreaterThan(term.x + term.width);
  expect(Math.abs(beside.y - term.y)).toBeLessThan(2);
  // Told the repo and the file in front, and nothing of it in the pane but the line run.
  expect(told[0]).toContain('"hello"');
  expect(told[0]).toContain('The file in front of the person: README.md');
  await expect(app.page.locator('.work.bench:not([hidden]) .pane-answer')).toHaveCount(0);
  // The box has no Agent of its own on the desk: it is the terminal's.
  await app.main.getByRole('button', {name: /^Input box action/}).click();
  await expect(app.main.getByRole('menuitemradio', {name: /Ask Agent/})).toHaveCount(0);
  await app.page.keyboard.press('Escape');

  await app.runtime.open('Agent');
  await app.main.getByRole('button', {name: 'Remove', exact: true}).click();
  await expect(app.main.getByRole('textbox', {name: 'API key'})).toBeVisible();
  await app.rail.go('forge');
  await box.focus();
  await box.fill('agent Again?');
  await box.press('Enter');
  await expect(app.forge.prompt.locator('.term-out')).toContainText('agent: No API key configured on this device; set one in Runtime');
});

test('signed in with a passkey, the key given is sealed by it: kept as given nowhere, opened once a session when the Agent is asked', async ({app}, info) => {
  const told: string[] = [];
  await maker(app.page, told, () => [{type: 'text', text: 'Sealed and answered.'}]);
  await app.signIn(personName(info));
  await app.main.getByRole('region', {name: 'Add passkey'}).getByRole('button', {name: 'Add passkey'}).click();
  await expect(app.main.getByText('Passkey added', {exact: true})).toBeVisible();
  await app.runtime.open('Agent');
  await app.main.getByRole('textbox', {name: 'API key'}).fill(KEY);
  await app.main.getByRole('button', {name: 'Use', exact: true}).click();
  await expect(app.main.locator('.agent-line')).toContainText('sk-ant-…9fAA');
  await expect(app.main.locator('.agent-note')).toContainText('Sealed by your passkey');
  // Nothing the page keeps holds the key as given.
  expect((await app.kept()).includes(KEY.slice(13, 40)), 'the key, as given, is in nothing the page keeps').toBe(false);

  // A new session: the Agent asked, the passkey opens the key (the authenticator here answers at once), and it answers.
  await app.page.reload();
  await app.settled();
  await app.rail.go('forge');
  const box = app.forge.promptBox;
  await box.focus();
  await box.fill('agent Still there?');
  await box.press('Enter');
  await expect(app.main.getByRole('region', {name: 'Agent', exact: true}).locator('.agent-words')).toContainText('Sealed and answered.');
});

test.describe('signed in', () => {
  test.use({storageState: undefined});
test('handed an issue\'s work, the Agent reads and writes its files: its terminal and the editor follow, and its box in Git says so', async ({signedIn: app}) => {
  const told: string[] = [];
  await maker(app.page, told, (asked) => {
    const turn = asked.messages.filter((m) => m.role === 'assistant').length;
    if (turn === 0) return [{type: 'text', text: 'Looking at the README.'}, {type: 'tool_use', id: 't1', name: 'read', input: {path: 'README.md'}}];
    if (turn === 1) return [{type: 'tool_use', id: 't2', name: 'edit', input: {path: 'README.md', edits: [{oldText: given(asked).trimEnd(), newText: `${given(asked).trimEnd()}\n\nBuild it with make.`}]}}];
    return [{type: 'text', text: 'Added how it is built to the README.'}];
  });
  await app.newRepo.make('hello');
  await app.runtime.open('Agent');
  await app.main.getByRole('textbox', {name: 'API key'}).fill(KEY);
  await app.main.getByRole('button', {name: 'Use', exact: true}).click();
  await expect(app.main.locator('.agent-line')).toContainText('model-one');
  // The repo on the issue's work: what the Agent is asked there is the issue's, and it may write.
  await app.git.write('hello', 'Docs: How to build');
  await app.git.step('Start').click();
  await expect(app.git.step('Back to main')).toBeVisible();
  await app.rail.go('forge');
  const box = app.forge.promptBox;
  await box.focus();
  await box.fill('agent Say in the README how it is built.');
  await box.press('Enter');
  const agent = app.main.getByRole('region', {name: 'Agent', exact: true});
  // Each step a line of its terminal, in the order done, its words where it said them.
  await expect(agent.getByRole('button', {name: 'Read README.md'})).toBeVisible();
  await expect(agent.getByRole('button', {name: 'Edited README.md (+2 −0)'})).toBeVisible();
  await expect(agent.locator('.agent-words').last()).toContainText('Added how it is built to the README.');
  // Written through the OS, as an editor elsewhere would: the one open on it shows it.
  await expect(app.forge.editor('README.md')).toHaveValue(/\n\nBuild it with make\.\n$/);
  // Told the issue whose work it is, and that it may write here.
  expect(told[0]).toContain('How to build');
  expect(told[0]).toContain('write the files that must change');
  await app.rail.go('git');
  // Its turn over, it is as any agent whose turn is over: by name, its last words, waiting on the person.
  const row = app.main.locator('.agent-row');
  await expect(row).toContainText('Agent');
  await expect(row).toContainText('Added how it is built');
  await expect(row).toHaveClass(/waits/);
});
});

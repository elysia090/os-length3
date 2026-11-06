import type {Page} from '@playwright/test';
import {expect, personName, test} from './fixtures.ts';

// The box's Agent: an API key given in Runtime's Agent (beside the dotfiles, apart from them) brings it among what the
// box does; asked there, the question goes into the right pane, and what the Agent does and says comes under it, the
// Prompt up only for what it runs. The maker is played here (its key's form is Anthropic's): its list of models, a
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

test('a key given in Runtime opens the box\'s Agent: asked, it answers in the pane, the Prompt never up; taken away, the box runs', async ({app}) => {
  const told: string[] = [];
  await maker(app.page, told, () => [{type: 'text', text: 'Run it so:\n\n```sh\nmake\n```\n'}]);
  await app.runtime.open('Agent');
  await app.main.getByRole('textbox', {name: 'API key'}).fill(KEY);
  await app.main.getByRole('button', {name: 'Use', exact: true}).click();
  // Shown by its start and last four, never whole; the model it opens beside.
  await expect(app.main.locator('.agent-line')).toContainText('sk-ant-…9fAA');
  await expect(app.main.locator('.agent-line')).toContainText('model-one');

  await app.rail.go('forge');
  const box = app.forge.promptBox, pill = app.main.getByRole('button', {name: /^Input box action/});
  await box.focus();
  await box.press('Alt+4');
  await expect(pill).toHaveAccessibleName('Input box action: Ask');
  await expect(pill.locator('.prompt-mode')).toHaveText('Agent@hello');
  await box.fill('How is it built?');
  await box.press('Control+Enter');
  await expect(box).toHaveValue('');
  const flow = app.page.locator('.work.bench:not([hidden]) .pane-rows');
  await expect(flow.getByRole('button', {name: 'Agent How is it built?'})).toBeVisible();
  await expect(flow.locator('.pane-answer')).toContainText('Run it so:');
  await expect(flow.locator('.pane-answer .answer-code')).toHaveText('make');
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
  // Run, Issue, TODO: on the desk the files are written in where they lie, so the box has no Edit.
  await expect(app.main.getByRole('menuitemradio')).toHaveCount(3);
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
  await box.press('Alt+4');
  await box.fill('Still there?');
  await box.press('Control+Enter');
  const flow = app.page.locator('.work.bench:not([hidden]) .pane-rows');
  await expect(flow.locator('.pane-answer')).toContainText('Sealed and answered.');
});

test.describe('signed in', () => {
  test.use({storageState: undefined});
test('handed an issue\'s work, the box\'s Agent reads and writes its files: the editor and the pane follow, and its box in Git says so', async ({signedIn: app}) => {
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
  await box.press('Alt+4');
  await box.fill('Say in the README how it is built.');
  await box.press('Control+Enter');
  const flow = app.page.locator('.work.bench:not([hidden]) .pane-rows');
  // Each step a line of the flow, its words under the line they follow.
  await expect(flow.getByRole('button', {name: 'Agent Read README.md'})).toBeVisible();
  await expect(flow.getByRole('button', {name: 'Agent Edited README.md (+2 −0)'})).toBeVisible();
  await expect(flow.locator('.pane-answer').last()).toContainText('Added how it is built to the README.');
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

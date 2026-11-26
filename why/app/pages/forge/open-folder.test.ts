import assert from 'node:assert/strict';
import {test} from 'node:test';
import {folderChoice} from './open-folder.ts';

type Draw = Parameters<typeof folderChoice>[1];
type State = Parameters<Draw>[0];

function scene() {
  let local = ['notes', 'garden'], remote = ['garden', 'remote'], allowed = true;
  const opened: string[] = [], brought: string[] = [];
  let state: State | null = null;
  let bring = async (name: string) => { brought.push(name); };
  let answer: boolean | void;
  let readingError: Error | undefined;
  const choice = folderChoice({
    storeNames: async () => { if (readingError) throw readingError; return local; },
    remoteNames: () => remote,
    bring: (name) => bring(name),
    open: (name) => { opened.push(name); return answer; },
    create: () => { opened.push('new'); },
    allowed: () => allowed,
  }, (value) => { state = value; });
  return {choice, state: () => state as State, opened, brought,
    names(here: string[], there: string[]) { local = here; remote = there; },
    bring(with_: typeof bring) { bring = with_; },
    allow(yes: boolean) { allowed = yes; },
    result(value: boolean | void) { answer = value; },
    listError(error?: Error) { readingError = error; },
  };
}

test('the offered folders are the real managed local and remote names, local first and deduplicated', async () => {
  const s = scene();
  await s.choice.load();
  assert.deepEqual(s.state(), {kind: 'list', folders: [
    {name: 'notes', remote: false}, {name: 'garden', remote: false}, {name: 'remote', remote: true},
  ]});
  await s.choice.choose('/home/person');
  await s.choice.choose(null);
  assert.deepEqual(s.opened, []);
  await s.choice.choose('garden');
  assert.deepEqual(s.opened, ['garden']);
  assert.deepEqual(s.brought, []);
  assert.equal(s.state().kind, 'closed');
});

test('remote selections wait for one successful bring, including a repeated activation', async () => {
  const s = scene();
  const bringing = Promise.withResolvers<void>();
  s.bring((name) => { s.brought.push(name); return bringing.promise; });
  await s.choice.load();
  const opening = s.choice.choose('remote');
  await s.choice.choose('remote');
  assert.deepEqual(s.opened, []);
  bringing.resolve();
  await opening;
  assert.deepEqual(s.brought, ['remote']);
  assert.deepEqual(s.opened, ['remote']);
});

test('closing or leaving the place while a remote folder is fetched never navigates on completion', async () => {
  for (const abandon of [(s: ReturnType<typeof scene>) => s.choice.close(), (s: ReturnType<typeof scene>) => s.allow(false)]) {
    const s = scene();
    const entered = Promise.withResolvers<void>();
    const bringing = Promise.withResolvers<void>();
    s.bring(() => { entered.resolve(); return bringing.promise; });
    await s.choice.load();
    const opening = s.choice.choose('remote');
    await entered.promise;
    abandon(s);
    bringing.resolve();
    await opening;
    assert.deepEqual(s.opened, []);
    assert.equal(s.state().kind, 'closed');
  }
});

test('a failed fetch or an open callback returning false never reports success or closes', async () => {
  const s = scene();
  s.bring(async () => { throw new Error('Unavailable'); });
  await s.choice.load();
  await s.choice.choose('remote');
  assert.deepEqual(s.opened, []);
  assert.equal(s.state().kind, 'list');
  assert.match(JSON.stringify(s.state()), /Unavailable/);
  s.result(false);
  await s.choice.choose('notes');
  assert.equal(s.state().kind, 'list');
  assert.match(JSON.stringify(s.state()), /not opened/);
});

test('a disappeared folder is not opened; a genuinely empty chooser can reach existing Create', async () => {
  const s = scene();
  await s.choice.load();
  s.names([], []);
  await s.choice.choose('notes');
  assert.deepEqual(s.opened, []);
  assert.deepEqual(s.state(), {kind: 'list', folders: [], error: 'Available folders changed. Choose again.'});
  s.names(['fresh'], []);
  await s.choice.choose(null);
  assert.deepEqual(s.opened, []);
  s.names([], []);
  await s.choice.load();
  await s.choice.choose(null);
  assert.deepEqual(s.opened, ['new']);
});

test('a local list failure is not an empty managed workspace', async () => {
  const s = scene();
  s.listError(new Error('List failed'));
  await s.choice.load();
  assert.deepEqual(s.state(), {kind: 'error', error: 'List failed'});
  await s.choice.choose(null);
  assert.deepEqual(s.opened, []);
  s.listError();
  await s.choice.load();
  assert.equal(s.state().kind, 'list');
});

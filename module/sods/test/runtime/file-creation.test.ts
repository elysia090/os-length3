import assert from 'node:assert/strict';
import {test} from 'node:test';
import {File, Dir, PendingFile} from '../../runtime/linux/fs.ts';

test('creation abort retires once even on reentry and publication is terminal', () => {
  let calls = 0;
  const pending = new PendingFile(new File(), () => { calls++; pending.abort(); });
  pending.abort(); pending.abort(); assert.equal(calls, 1);
  assert.throws(() => pending.publish(new Dir(), 'a'), /resolved/);
  const dir = new Dir(), published = new PendingFile(new File(), () => { throw Error('must not retire'); });
  assert.equal(published.publish(dir, 'a'), published.file);
  published.abort(); assert.equal(dir.entries.get('a'), published.file);
  assert.throws(() => published.publish(dir, 'b'), /resolved/);
});

test('failed publication retains both errors and does not retry retirement', () => {
  const failed = Error('publish'), cleanup = Error('cleanup'), dir = new Dir(); let calls = 0;
  dir.entries.set = () => { throw failed; };
  const pending = new PendingFile(new File(), () => { calls++; throw cleanup; });
  assert.throws(() => pending.publish(dir, 'a'), (error: unknown) => error instanceof AggregateError &&
    error.errors[0] === failed && error.errors[1] === cleanup);
  pending.abort(); assert.equal(calls, 1);
});


test('prepublication preparation failure retains its error when retirement also fails', () => {
  const failed = Error('prepare'), cleanup = Error('cleanup'); let calls = 0;
  const pending = new PendingFile(new File(), () => { calls++; throw cleanup; });
  assert.throws(() => {
    try { throw failed; }
    catch (error) { pending.reject(error); }
  }, (error: unknown) => error instanceof AggregateError && error.errors[0] === failed && error.errors[1] === cleanup);
  pending.abort(); assert.equal(calls, 1);
});

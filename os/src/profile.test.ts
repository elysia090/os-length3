import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EMPTY, initials, LIMITS, normalize, parse, validHandle} from './profile.ts';

test('a profile l3 kept is read whole: its limits count characters, as l3 counts them', () => {
  // 50 characters beyond the BMP are 100 UTF-16 units; l3 takes them as 50 (core/src/home.rs PROFILE_LIMITS).
  const name = '😀'.repeat(LIMITS.name), bio = '𝄞'.repeat(LIMITS.bio);
  assert.deepEqual(parse(JSON.stringify({name, handle: 'ren', bio})), {name, handle: 'ren', bio});
  // Past the limit it is cut between characters, never inside one.
  assert.equal(normalize({name: `${name}😀`, handle: '', bio: ''}).profile.name, name);
});

test('initials come from the name, then the handle', () => {
  assert.equal(initials({name: 'Ren Tamura', handle: 'ren', bio: ''}), 'RT');
  assert.equal(initials({name: '田村', handle: '', bio: ''}), '田村');
  assert.equal(initials({name: '', handle: 'ren', bio: ''}), 'R');
  assert.equal(initials(EMPTY), '');
});

test('handles are normalized and validated', () => {
  assert.deepEqual(normalize({name: ' A ', handle: '@Ren_3', bio: ' x '}),
    {profile: {name: 'A', handle: 'ren_3', bio: 'x'}, error: null});
  assert.equal(normalize({name: '', handle: 'has space', bio: ''}).error, 'handle');
  assert.ok(!validHandle(''));
  assert.ok(!validHandle('a'.repeat(33)));
});

test('stored profiles are accepted only when well formed', () => {
  assert.deepEqual(parse(JSON.stringify({name: 'A', handle: 'a', bio: ''})), {name: 'A', handle: 'a', bio: ''});
  assert.deepEqual(parse('{"name":1}'), EMPTY);
  assert.deepEqual(parse('not json'), EMPTY);
  assert.deepEqual(parse(null), EMPTY);
  assert.deepEqual(parse(JSON.stringify({name: 'A', handle: 'bad handle', bio: ''})), EMPTY);
});

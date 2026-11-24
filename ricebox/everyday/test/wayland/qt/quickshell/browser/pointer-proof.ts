import assert from 'node:assert/strict';

/** The runner separately verifies both genuine raster colors and composited pixels. */
export function checkPointerCommits(receipt: string): void {
  const lines = receipt.split('\n');
  const commits = lines.filter(line => line.startsWith('WAYLAND_COMMIT '));
  assert.equal(commits.length, 2, 'Expected exactly two guest panel commits');
  const configured = /^WAYLAND_COMMIT seq=1 size=32x24 configure=([1-9]\d*) pointer=0 stride=\d+$/.exec(commits[0]!);
  assert.ok(configured, 'First panel commit must precede guest pointer input');
  const second = /^WAYLAND_COMMIT seq=2 size=32x24 configure=([1-9]\d*) pointer=[1-9]\d* stride=\d+$/.exec(commits[1]!);
  assert.ok(second, 'Second panel commit must follow an actual forwarded Wayland pointer contact');
  assert.equal(second[1], configured[1], 'A configure/resize is not a pointer response');
  assert.ok(lines.indexOf('WAYLAND_LAYER_CLIENT_DESTROY') > lines.indexOf(commits[1]!), 'Layer must close after the second commit');
}

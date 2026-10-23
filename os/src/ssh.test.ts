import assert from 'node:assert/strict';
import {test} from 'node:test';
import {QUIET, lan, quiet} from './ssh.ts';

test('the addresses listened on besides loopback are said after their interfaces, as l3 address says them', () => {
  assert.deepEqual(lan({bound: ['192.168.1.5', '100.101.102.103', '127.0.0.1', '::1'],
    interfaces: [{addr: '192.168.1.5', interface: 'wlan0'}, {addr: '100.101.102.103', interface: 'tailscale0'}]}), ['wlan0 192.168.1.5', 'tailscale0 100.101.102.103']);
  // From an l3 that kept no interfaces: the addresses alone.
  assert.deepEqual(lan({bound: ['192.168.1.5', '127.0.0.1', '::1']}), ['192.168.1.5']);
  assert.deepEqual(lan({bound: ['127.0.0.1', '::1'], interfaces: []}), []);
});

test('a device that has not said it still listens for a while is shown as quiet', () => {
  const now = 1_800_000_000_000;
  // It asks every 30 s or so; a missed beat or two are not yet quiet.
  assert.equal(quiet({seen: now - 5_000}, now), false);
  assert.equal(quiet({seen: now - QUIET}, now), false);
  assert.equal(quiet({seen: now - QUIET - 1}, now), true);
});

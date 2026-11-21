import assert from 'node:assert/strict';
import {test} from 'node:test';
import {lan} from './host.ts';

test('the addresses listened on besides loopback are said after their interfaces, as why address says them', () => {
  assert.deepEqual(lan({bound: ['192.168.1.5', '100.101.102.103', '127.0.0.1', '::1'],
    interfaces: [{addr: '192.168.1.5', interface: 'wlan0'}, {addr: '100.101.102.103', interface: 'tailscale0'}]}), ['wlan0 192.168.1.5', 'tailscale0 100.101.102.103']);
  // From a why that kept no interfaces: the addresses alone.
  assert.deepEqual(lan({bound: ['192.168.1.5', '127.0.0.1', '::1']}), ['192.168.1.5']);
  assert.deepEqual(lan({bound: ['127.0.0.1', '::1'], interfaces: []}), []);
});

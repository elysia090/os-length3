import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {bridge} from './bridge.ts';

test('the bridge completes WebSocket closure in either direction', {timeout: 5_000}, async t => {
  // This is a transport test: no Postgres messages are sent. Real database
  // startup and protocol traffic belong to worker.test.ts, not this deadline.
  let protocolCalls = 0;
  const b = await bridge({pglite: {execProtocolRaw: async () => {
    protocolCalls++;
    throw new Error('WebSocket closure must not execute SQL');
  }}});
  t.after(() => b.close());
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${b.port}`);
    await once(socket, 'open');
    return socket;
  };
  const closed = (socket: WebSocket): Promise<CloseEvent> => new Promise((resolve, reject) => {
    socket.addEventListener('close', resolve, {once: true});
    socket.addEventListener('error', () => reject(new Error('WebSocket closed without a close handshake')), {once: true});
  });

  const client = await connect(), fromClient = closed(client);
  client.close(4000, 'fixture done');
  const clientClose = await fromClient;
  assert.deepEqual({code: clientClose.code, reason: clientClose.reason, clean: clientClose.wasClean},
    {code: 4000, reason: 'fixture done', clean: true});

  const server = await connect(), fromServer = closed(server);
  const [serverClose] = await Promise.all([fromServer, b.close()]);
  assert.deepEqual({code: serverClose.code, clean: serverClose.wasClean}, {code: 1000, clean: true});
  assert.equal(protocolCalls, 0, 'neither close handshake sends Postgres messages');
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {asks, Refused} from './asks.ts';
const base = JSON.stringify({ociVersion: '1.2.0', process: {args: ['/program'], cwd: '/'}, root: {path: 'rootfs'}, linux: {namespaces: ['mount','pid','ipc','uts','network'].map((type) => ({type}))}});
const withValue = (value: string) => base.slice(0, -1) + ',"extension":' + value + '}';
const bytes = (value: string) => new TextEncoder().encode(value);
export const invalidValues = ['bananas', '01', '-01', '-.1', '1.', '1e', '[1,]', '[1 2]', '{"x" 1}', '{,"x":1}', '[}', '{]'];
test('unknown extension fields still obey the independent JSON grammar', () => {
  for (const value of invalidValues) {
    const text = withValue(value);
    assert.throws(() => JSON.parse(text), SyntaxError);
    assert.throws(() => asks(bytes(text)), Refused, value);
  }
  for (const value of ['null', 'true', '-1.2e+3', '[null,{},[]]', '{"a":[true,"value"]}', '"\\u0000"']) {
    const text = withValue(value); JSON.parse(text); assert.doesNotThrow(() => asks(bytes(text)), value);
  }
});
test('version and device restrictions are applied or refused, never ignored', () => {
  assert.throws(() => asks(bytes(base.replace('"1.2.0"', '"2.0.0"'))), Refused);
  assert.throws(() => asks(bytes(base.replace('"ociVersion":"1.2.0",', ''))), Refused);
  const config = JSON.parse(base);
  config.linux.resources = {devices: [{allow: false, type: 'c', major: 1, minor: 3, access: 'r'}]};
  assert.throws(() => asks(bytes(JSON.stringify(config))), /device rules are not enforced/);
});

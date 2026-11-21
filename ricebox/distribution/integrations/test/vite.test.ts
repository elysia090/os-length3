import {test} from 'node:test';
import assert from 'node:assert/strict';
import ricebox, {distributionAssets} from '../vite.ts';
import {distributionAssets as assets} from '../../deployment/assets.ts';
import {fixture} from '../../deployment/test/fixture.ts';

test('the existing Vite named export is the neutral asset function',()=>assert.equal(distributionAssets,assets));

test('uses ES Workers and emits existing AOT distribution unchanged', t => {
  const {root} = fixture(t), plugin = ricebox({distribution:root,base:'runtime/assets'}), emitted: {type: string; fileName: string}[]=[];
  assert.equal(plugin.config().worker.format,'es');
  plugin.generateBundle.call({emitFile: a => emitted.push(a)});
  assert.equal(emitted.length,6);
  assert.ok(emitted.every(a => a.type === 'asset' && a.fileName.startsWith('runtime/assets/')));
});


test('failed composition cannot emit a prepared distribution',async()=>{
  const build={packages:['base'],packageCache:'/unused',output:'/unused'};
  assert.throws(()=>ricebox({distribution:'/unused',build}),/choose distribution or build/);
  const plugin=ricebox({build});
  await assert.rejects(plugin.buildStart(),/provide pinned tools/);
  let emitted=0;
  plugin.generateBundle.call({emitFile(){emitted++;}});
  assert.equal(emitted,0);
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {Kernel, loadFileScope, Vfs, type Image} from '../../../sods/runtime/linux.ts';
import {TranslationObserver, type TranslationMessage} from '../translation-observer.ts';

const enc = new TextEncoder(), name = enc.encode('sods.facts'), facts = enc.encode('{}');
const module = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0,0,1+name.length+facts.length,name.length,...name,...facts]));
function image(): Image {
  const vfs = new Vfs(), file = vfs.writeFile('/a', 'source');
  const k = new Kernel({vfs, translate() { throw Error('unused'); }, console: {write() {}, read: () => null}});
  k.prebuilt(file, module); return k.images.get(file)!.image;
}
function extra(im: Image, value: number) {
  im.extras.push({module, bytes: new Uint8Array([value]), base: im.extras.length, count: 1});
}
const entry = (im: Image) => [{image: im, kept: false}];

test('observer preserves message shapes and captured prefix under reentry', () => {
  const o = new TranslationObserver(), im = image(); extra(im, 1); o.track('/same', im);
  const messages: TranslationMessage[] = [];
  o.publish([], (m) => {
    messages.push(m);
    assert.throws(() => o.publish([], () => {}), /already active/);
    assert.throws(() => o.track('/other', image()), /already active/);
    extra(im, 2);
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'more');
  assert.deepEqual((messages[0] as Extract<TranslationMessage, {type:'more'}>).more[0].bytes, new Uint8Array([1]));
  o.publish([], m => messages.push(m));
  assert.equal(messages.length, 2);
  assert.equal((messages[1] as Extract<TranslationMessage, {type:'more'}>).from, 1);
});

test('main transfer accepted before extras failure keeps prefix and fails closed', () => {
  const o = new TranslationObserver(), im = image();
  im.origin = 'root'; im.mainTold = false; im.told = 0; im.wasm = new Uint8Array([1,2]); extra(im, 3);
  const messages: TranslationMessage[] = [];
  assert.throws(() => o.publish(entry(im), (m, options) => {
    if (m.type === 'reached') throw Error('send refused');
    messages.push(structuredClone(m, options));
  }), /send refused/);
  assert.equal(messages.length, 1); assert.equal(im.mainTold, true); assert.equal(im.wasm, null); assert.equal(im.told, 0);
  assert.throws(() => o.publish(entry(im), () => { throw Error('must not resend'); }), /publication failed/);
  o.close(); o.close();
});

test('main send may transfer and then throw: never retry a detached payload', () => {
  const o = new TranslationObserver(), im = image(); im.origin = 'root'; im.wasm = new Uint8Array([1]);
  assert.throws(() => o.publish(entry(im), (m, options) => { structuredClone(m, options); throw Error('ambiguous'); }), /ambiguous/);
  assert.equal(im.wasm.byteLength, 0); assert.notEqual(im.mainTold, true);
  assert.throws(() => o.publish(entry(im), () => {}), /publication failed/);
  assert.throws(() => o.track('/a', im), /publication failed/); o.close();
});

test('close during accepted send stops subsequent messages and never closes an Image', () => {
  const o = new TranslationObserver(), a = image(), b = image(); extra(a,1); extra(b,2);
  o.track('/same', a); o.track('/same', b);
  let sent = 0;
  o.publish([], () => { sent++; o.close(); });
  assert.equal(sent, 1); assert.equal(new TextDecoder().decode(a.source!()), 'source');
  assert.throws(() => o.publish([], () => {}), /closed/);
});

test('same path old/new images stay independent; keeper seed and changed suppression remain', () => {
  const o = new TranslationObserver(), old = image(), next = image(); extra(old,1); extra(next,2);
  const observation = o.track('/same', old); o.track('/same', next);
  const messages: TranslationMessage[] = []; o.publish([], m => messages.push(m)); assert.equal(messages.length,2);
  observation.close(); extra(old,3); next.changed = true; extra(next,4);
  o.publish([], m => messages.push(m)); assert.equal(messages.length,2);
  const seed = image(); seed.origin='root'; seed.mainTold=true; seed.told=1; extra(seed,1); extra(seed,2);
  o.publish(entry(seed), m => messages.push(m));
  assert.equal(messages[2].type,'reached'); assert.equal((messages[2] as Extract<TranslationMessage,{type:'reached'}>).from,1);
  // Consolidation creates a distinct image with its own fresh publication state.
  const consolidated = image(); consolidated.origin='root'; consolidated.wasm=new Uint8Array([9]); consolidated.told=0;
  o.publish(entry(consolidated), m => messages.push(m)); assert.equal(messages[3].type,'translated');
  assert.equal(seed.told,2); assert.equal(consolidated.mainTold,true); o.close();
});

test('observer close releases only observation, not a Rust-backed deferred source', {skip: !process.env.SODS_FILE_STORE_WASM}, async () => {
  const scope = await loadFileScope(readFileSync(process.env.SODS_FILE_STORE_WASM!),32), vfs=scope.createVfs();
  try {
    let loads=0; const file=scope.lazyFile(vfs,'/image',()=>{loads++;return enc.encode('source');});
    const k=new Kernel({vfs,translate(){throw Error('unused');},console:{write(){},read:()=>null}});
    k.prebuilt(file,module); const im=k.images.get(file)!.image, o=new TranslationObserver();
    extra(im,1); o.track('/image',im); k.images.delete(file); vfs.root.entries.delete('image'); k.ended();
    o.publish([],()=>{}); assert.equal(loads,0); o.close();
    assert.equal(new TextDecoder().decode(im.source!()),'source'); assert.equal(loads,1);
  } finally {scope.dispose();}
});

test('rejected main preserves local bytes and root extras acknowledge only their captured end', () => {
  const rejected = image(), failed = new TranslationObserver(); rejected.origin='root'; rejected.wasm=new Uint8Array([7]);
  assert.throws(()=>failed.publish(entry(rejected),()=>{throw Error('refused');}),/refused/);
  assert.deepEqual(rejected.wasm,new Uint8Array([7])); assert.notEqual(rejected.mainTold,true); failed.close();
  const im=image(), o=new TranslationObserver(); im.origin='root'; im.mainTold=true; im.told=0; extra(im,1);
  o.publish(entry(im),()=>extra(im,2)); assert.equal(im.told,1);
  const messages:TranslationMessage[]=[]; o.publish(entry(im),m=>messages.push(m));
  assert.equal(messages.length,1); assert.equal((messages[0] as Extract<TranslationMessage,{type:'reached'}>).from,1);
  assert.equal(im.told,2); o.close();
});

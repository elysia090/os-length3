import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {checkPresenter} from './presenter-pin.mjs';
import {framePins,protocol} from './wayland-contract.mjs';
test('musl display intake refuses replacement, symlink and same-length fake bytes',()=>{
  const d=mkdtempSync(join(tmpdir(),'rx-display-check-'));
  try{
    const file=join(d,'presenter'), link=join(d,'link');
    writeFileSync(file,Buffer.alloc(257976)); symlinkSync(file,link);
    assert.throws(()=>checkPresenter(link),/PRESENTER_NOT_PINNED_REGULAR_ELF/);
    assert.throws(()=>checkPresenter(file),/PRESENTER_SHA256_MISMATCH/);
    writeFileSync(file,'short');
    assert.throws(()=>checkPresenter(file),/PRESENTER_NOT_PINNED_REGULAR_ELF/);
    assert.equal(framePins.length,3);
    assert.ok(framePins.every(p=>/^[a-f0-9]{64}$/.test(p)));
    assert.equal(protocol.filter(s=>s.startsWith('WAYLAND_COMMIT ')).length,3);
  }finally{rmSync(d,{recursive:true,force:true})}
});
test('optional real input matches exact locally approved musl ELF pin',{skip:!process.env.EVERYDAY_MUSL_PRESENTER},()=>{
  assert.equal(checkPresenter(process.env.EVERYDAY_MUSL_PRESENTER).length,257976);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {checkRange} from './probe-staged.mjs';
// Run from a scratch copy alongside the sealed probe-site, origin and routes code.
test('wire canary accepts exact slice, rejects fallback/wrong header/wrong bytes',async()=>{
  let mode='correct';
  const s=createServer((req,res)=>{
    assert.equal(req.headers.range,'bytes=3-5');
    assert.equal(req.headers['accept-encoding'],'identity');
    const data=mode==='corrupt'?'xyz':'def';
    res.writeHead(mode==='fallback'?200:206,{'Content-Length':3,'Content-Range':mode==='wrong-total'?'bytes 3-5/9':'bytes 3-5/10'});
    res.end(data);
  });
  s.listen(0,'127.0.0.1');await once(s,'listening');
  const run=()=>checkRange('http://127.0.0.1:'+s.address().port+'/demo/ricebox/packs/'+'a'.repeat(64)+'.pack',Buffer.from('def'),3,5,10);
  try {
    assert.equal((await run()).bytes,3);
    mode='fallback';await assert.rejects(run(),/MISSING_EXACT_PARTIAL_RESPONSE/);
    mode='wrong-total';await assert.rejects(run(),/MISSING_EXACT_PARTIAL_RESPONSE/);
    mode='corrupt';await assert.rejects(run(),/PARTIAL_BODY_MISMATCH/);
  } finally {await new Promise((r,j)=>s.close(e=>e?j(e):r()))}
});

import assert from 'node:assert/strict';
import {hasReadinessLine} from '../../src/v2/web/console-readiness.mjs';
for(const marker of ['console-ready','interactive-ready']){
  for(const text of [`${marker}\n`,`prefix\n${marker}\n`,`prefix\r\n${marker}\r\n`])
    assert(hasReadinessLine(text,marker));
  for(const text of [marker,`${marker}: starting\n`,`service ${marker}: starting\n`,
    `echo ${marker}\n`,`x${marker}\n`,`${marker}x\n`,`prefix\r${marker}\n`])
    assert(!hasReadinessLine(text,marker),text);
  const fragmented=`prefix\r\n${marker}\r\n`;
  for(let end=0;end<fragmented.length;++end)
    assert(!hasReadinessLine(fragmented.slice(0,end),marker),'no early partial marker');
  assert(hasReadinessLine(fragmented,marker));
}
assert.throws(()=>hasReadinessLine('anything\n','.*'),TypeError);
console.log('bootstrap readiness observations: complete exact LF/CRLF only; service diagnostics and incomplete chunks rejected');

import assert from 'node:assert/strict';
import {hasReadinessLine} from '../../src/v2/web/console-readiness.mjs';
for(const marker of ['console-ready','interactive-ready','boot-offline-complete']){
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
assert.equal(hasReadinessLine('console-ready\r\n~ # ', 'console-ready'), true);
const serviceList = 's6rc-oneshot-runner\r\nmdevd-ready\r\ncoldplug\r\ninteractive-ready\r\n';
assert.equal(hasReadinessLine(serviceList, 'boot-offline-complete'), false);
assert.equal(hasReadinessLine('~ # echo boot-offline-complete\r\n', 'boot-offline-complete'), false);
assert.equal(hasReadinessLine('boot-offline-complete', 'boot-offline-complete'), false);
assert.equal(hasReadinessLine('console-ready\r\nboot-offline-complete\r\n', 'boot-offline-complete'), true);
assert.equal(hasReadinessLine('Service initialization failed; inspect its live state from the console.\r\n', 'boot-offline-complete'), false);
console.log('console readiness: pass (service listing is not startup completion)');

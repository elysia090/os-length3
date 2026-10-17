// Independent expected bytes, not a hash copied from the guest under test.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const path=process.argv[2];
if(!path)throw new Error('usage: node check-browser-userland-receipt.mjs CONSOLE-LOG');
const text=readFileSync(path,'utf8').replaceAll('\r','');
const start=text.lastIndexOf('expected-receipt-begin\n');
const end=text.indexOf('expected-receipt-end',start);
if(start<0||end<start)throw new Error('complete guest-external receipt required');
const receipt=text.slice(start+'expected-receipt-begin\n'.length,end);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const lines=receipt.trimEnd().split('\n');
const hashes=lines.filter(x=>/^[0-9a-f]{64}  /.test(x));
const rows=new Map(hashes.map(x=>[x.slice(66),x.slice(0,64)]));
if(rows.size!==hashes.length)throw new Error('duplicate hash coordinate');
const expected=new Map([
  ['stdout.txt','child-out\n'],['stderr.txt','child-err\n'],
  ['text.txt','keep 2\ndrop 99\nkeep 5\n'],['space name.txt','first\nsecond\n'],
  ['private.txt','permission-proof\nshared-update\n'],['hard.txt','permission-proof\nshared-update\n'],
  ['payload.bin','0123456789abcdef'.repeat(65536)],
]);
for(let i=0;i<128;++i){const id=String(i).padStart(3,'0');expected.set('small/item-'+id,`file:${id}:nonzero\n`);}
const elf=rows.get('stored-program');
if(!elf)throw new Error('externally retained ELF identity required');
rows.delete('stored-program');
if(rows.size!==expected.size)throw new Error(`hash count: ${rows.size} != ${expected.size}`);
for(const [name,bytes] of expected)if(rows.get(name)!==digest(bytes))throw new Error('independent byte mismatch: '+name);
const metadata=['644 2 private.txt','644 2 hard.txt','777 1 symbolic.txt','644 1 payload.bin','755 1 stored-program'];
if(lines.length!==hashes.length+metadata.length)throw new Error('noncanonical receipt rows');
for(const line of metadata)if(!lines.includes(line))throw new Error('metadata mismatch: '+line);
for(const group of ['shell-and-text','files','permissions','links','process-and-signal','tar-gzip','stored-elf','sync','all'])
  if(!new RegExp('^userland-check:PASS:'+group+'$','m').test(text))throw new Error('missing group: '+group);
for(const group of ['shell','files','permissions','links','process','archive','elf','receipt'])
  if(!new RegExp('^userland-check:RESULT:'+group+':0$','m').test(text))throw new Error('missing successful exit: '+group);
if(text.includes('userland-check:FAIL:')||/^userland-check:RESULT:[^:]+:[1-9]/m.test(text))throw new Error('a guest group failed');
let coldRestoreData='separate-required';
if(process.argv[3]){
  const restored=readFileSync(process.argv[3],'utf8').replaceAll('\r','');
  const begin=restored.lastIndexOf('restore-receipt-begin\n'),finish=restored.indexOf('restore-receipt-end',begin);
  if(begin<0||finish<begin||restored.slice(begin+'restore-receipt-begin\n'.length,finish)!==receipt
      ||!/^restored-program-exit:7$/m.test(restored)||!/^userland-check:PASS:cold-restore:\/.+$/m.test(restored))
    throw new Error('cold restored bytes/metadata/ELF differ from the guest-external original');
  coldRestoreData='pass';
}
console.log(JSON.stringify({format:'browser-userland-receipt-v1',status:'pass',hashes:rows.size,payloadBytes:1048576,
  compiledElfSha256:elf,
  coldRestoreData,workerLifecycle:'separate-required',jobs:'separate-required',package:'separate-required',terminal:'separate-required'}));

import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const dir=mkdtempSync(join(tmpdir(),'length3-receipt-'));
const file=join(dir,'console.txt'),checker=fileURLToPath(new URL('./check-browser-userland-receipt.mjs',import.meta.url));
const restoreFile=join(dir,'restored.txt');
const row=(name,bytes)=>createHash('sha256').update(bytes).digest('hex')+'  '+name+'\n';
let body='';
for(const [name,bytes] of [['stdout.txt','child-out\n'],['stderr.txt','child-err\n'],['text.txt','keep 2\ndrop 99\nkeep 5\n'],
  ['space name.txt','first\nsecond\n'],['private.txt','permission-proof\nshared-update\n'],['hard.txt','permission-proof\nshared-update\n'],
  ['payload.bin','0123456789abcdef'.repeat(65536)]])body+=row(name,bytes);
for(let i=0;i<128;++i){const id=String(i).padStart(3,'0');body+=row('small/item-'+id,`file:${id}:nonzero\n`);}
body+='644 2 private.txt\n644 2 hard.txt\n777 1 symbolic.txt\n644 1 payload.bin\n755 1 stored-program\n';
body+=row('stored-program','synthetic checker fixture only');
const prefix=['shell-and-text','files','permissions','links','process-and-signal','tar-gzip','stored-elf','sync','all'].map(x=>'userland-check:PASS:'+x+'\n').join('')
  +['shell','files','permissions','links','process','archive','elf','receipt'].map(x=>'userland-check:RESULT:'+x+':0\n').join('');
const valid=prefix+'expected-receipt-begin\n'+body+'expected-receipt-end\n';
let negatives=0;
try{
  function run(text,want){writeFileSync(file,text);const r=spawnSync(process.execPath,[checker,file],{encoding:'utf8'});
    if((r.status===0)!==want)throw new Error('receipt test failed: '+r.stdout+r.stderr);}
  run(valid,true);
  for(const bad of [valid.replace('stdout.txt','wrong.txt'),valid.replace(/^[0-9a-f]{64}/m,'0'.repeat(64)),
    valid.replace(/^.*small\/item-127\n/m,''),valid.replace('644 2 hard.txt','644 1 hard.txt'),
    valid.replace('expected-receipt-end','truncated'),valid.replace('PASS:process-and-signal','FAIL:process-and-signal'),
    valid.replace('expected-receipt-end',row('stdout.txt','child-out\n')+'expected-receipt-end'),
    valid.replace('755 1 stored-program','644 1 stored-program'),valid.replace('PASS:all\n','PASS:all-incomplete\n'),
    valid.replace('RESULT:permissions:0','RESULT:permissions:7'),valid.replace('RESULT:archive:0\n','')]){
    run(bad,false);++negatives;
  }
  writeFileSync(file,valid);
  const restored='restore-receipt-begin\n'+body+'restore-receipt-end\nrestored-program-exit:7\nuserland-check:PASS:cold-restore:/test\n';
  function restoreRun(text,want){writeFileSync(restoreFile,text);const r=spawnSync(process.execPath,[checker,file,restoreFile],{encoding:'utf8'});
    if((r.status===0)!==want)throw new Error('restore receipt test failed: '+r.stdout+r.stderr);}
  restoreRun(restored,true);
  for(const bad of [restored.replace('644 2 hard.txt','644 1 hard.txt'),restored.replace('restored-program-exit:7','restored-program-exit:0'),
    restored.replace('cold-restore:','not-restored:'),restored.replace(/^.*small\/item-127\n/m,''),
    restored.replace(row('stored-program','synthetic checker fixture only'),row('stored-program','different ELF'))]){
    restoreRun(bad,false);++negatives;
  }
  console.log(JSON.stringify({status:'pass',positive:2,negative:negatives,scope:'receipt verifier only; not guest execution'}));
}finally{rmSync(file,{force:true});rmSync(restoreFile,{force:true});rmdirSync(dir);}

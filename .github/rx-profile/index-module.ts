import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {program,hash} from './decoder.ts';
const [filename]=process.argv.slice(2),b=fs.readFileSync(filename),p=program(b);
const rows=[...p.fixtures].map(([idx,q])=>({idx,start:q.start,end:q.end,name:p.names.get(idx)??null,guest:idx>=13?'0x'+p.pc[idx-13].toString(16):null,bodySha:hash(b.subarray(q.start,q.end))}));console.log(JSON.stringify({sha:p.sha,role:'checked-pinned-shape',rows}));

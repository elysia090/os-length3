import {createHash} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import {presenter} from './wayland-contract.mjs';
function sha(bytes){return createHash('sha256').update(bytes).digest('hex')}
function need(ok,name){if(!ok)throw Error(name)}
export function checkPresenter(file) {
  const st=lstatSync(file);
  need(st.isFile()&&st.size===257976,'PRESENTER_NOT_PINNED_REGULAR_ELF');
  const b=readFileSync(file);
  need(sha(b)===presenter,'PRESENTER_SHA256_MISMATCH');
  need(b.subarray(0,6).equals(Buffer.from([0x7f,69,76,70,2,1]))&&b.readUInt16LE(18)===62,'PRESENTER_WRONG_ELF');
  const p=Number(b.readBigUInt64LE(32)),n=b.readUInt16LE(56),stride=b.readUInt16LE(54);
  need(Number.isSafeInteger(p)&&stride===56&&n>0&&p>=64&&p+n*stride<=b.length,'PRESENTER_BAD_ELF_TABLE');
  let x=false;
  for(let i=0;i<n;i++){
    const j=p+i*stride,t=b.readUInt32LE(j);
    need(t!==3&&t!==2,'PRESENTER_DYNAMIC_ELF');
    x ||= t===1&&!!(b.readUInt32LE(j+4)&1);
  }
  need(x,'PRESENTER_NO_EXEC_SEGMENT');
  return b;
}

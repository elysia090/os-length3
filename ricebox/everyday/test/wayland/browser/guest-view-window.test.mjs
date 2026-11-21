import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bindGuestViewWindow} from './guest-view-window.mts';
import {offerShell} from './shell-page.mts';

test('expired keeper denies trusted popup before delayed timers run', () => {
  let windowOpen=0, cleanup=0;
  const timers=[], old=globalThis.window;
  const keeper=Object.assign(new EventTarget(),{
    setInterval:(f)=>{timers.push(f);return 1;},setTimeout:(f)=>{timers.push(f);return 2;},
    clearInterval(){},clearTimeout(){},open(){windowOpen++;return null;},
  });
  globalThis.window=keeper;
  try {
    const slot={append(){}},view={parentElement:slot};
    const button={disabled:false,onclick:null},endButton={disabled:false},status={textContent:''};
    bindGuestViewWindow({view,slot,openButton:button,endButton,status,stopDrawing(){},endSession(){cleanup++;},
      canAct:()=>false,budgetMs:500});
    button.onclick({isTrusted:true});
    assert.equal(windowOpen,0);assert.equal(cleanup,0);
    timers[1]();
    assert.equal(cleanup,1);assert.equal(button.disabled,true);
  } finally { globalThis.window=old; }
});

test('terminal form cannot default-navigate even while owned Worker retirement is pending', async () => {
  const old=globalThis.window;globalThis.window=new EventTarget();
  let alive=true,terminated=0;
  const sent=[], worker=Object.assign(new EventTarget(),{
    postMessage(value){sent.push(value.type);},
    terminate(){terminated++;},
  });
  try {
    const button={disabled:false},status={dataset:{},textContent:''},output={textContent:''},line={disabled:true,value:''},send={disabled:true};
    const form={querySelector: selector=>selector==='input'?line:send};
    const elements={'#shell-open':button,'#shell-status':status,'#shell-output':output,form};
    const section={querySelector:k=>elements[k],hidden:true};
    const asset=Uint8Array.of(1,2,3);
    const retire=offerShell(section,async()=>asset,asset,asset,()=>worker,undefined,false,()=>alive);
    await button.onclick();
    assert.deepEqual(sent,['start']);
    worker.dispatchEvent(new MessageEvent('message',{data:{type:'waiting',for:'input'}}));
    assert.equal(line.disabled,false);
    alive=false;
    let prevented=false;line.value='must not be submitted';
    form.onsubmit({preventDefault(){prevented=true;}});
    assert.equal(prevented,true);assert.deepEqual(sent,['start']);
    const done=retire();
    assert.equal(line.disabled,true);assert.equal(send.disabled,true);
    assert.equal(terminated,0);assert.deepEqual(sent,['start','retire']);
    prevented=false;form.onsubmit({preventDefault(){prevented=true;}});
    assert.equal(prevented,true);assert.deepEqual(sent,['start','retire']);
    worker.dispatchEvent(new MessageEvent('message',{data:{type:'retiring',failures:[]}}));
    await done;
    assert.equal(terminated,1);assert.equal(status.dataset.phase,'closed');
  } finally {globalThis.window=old;}
});

import {LinuxTerminal,readLinuxConfig} from '/web/linux-terminal.js';
const $=id=>document.getElementById(id),terminal=new LinuxTerminal();
const pin='7ae8a85018b49656c8212e4984baf9500656ee3a2ef642a149752954924729f9';
const config=readLinuxConfig()??readLinuxConfig('?'+new URLSearchParams({'linux-release':`/releases/${pin}/artifact/release/release.json`,
  'linux-release-sha256':pin,'linux-workspace':'os-length3-0.1.0','linux-workspace-bytes':'33554432'}));
let wasRunning=false,hasStarted=false,pendingRun=null;
const key='length3.os.files.v1';let files=[],active=0,timer;
function choose(name){
  for(const section of ['terminal','playground','files'])$(section).hidden=section!==name;
  for(const b of document.querySelectorAll('nav button')){if(b.dataset.surface===name)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}
  const url=new URL(location);url.searchParams.set('focus',name);history.replaceState(null,'',url);
}
document.querySelectorAll('nav button').forEach((b,i,buttons)=>{b.onclick=()=>choose(b.dataset.surface);b.onkeydown=e=>{
  let n=e.key==='Home'?0:e.key==='End'?buttons.length-1:e.key==='ArrowRight'?(i+1)%buttons.length:e.key==='ArrowLeft'?(i+buttons.length-1)%buttons.length:null;
  if(n!==null){e.preventDefault();buttons[n].focus();choose(buttons[n].dataset.surface);}};});
const focus=new URL(location).searchParams.get('focus');choose(['source','run','editor','playground'].includes(focus)?'playground':focus==='files'?'files':'terminal');
$('start').onclick=()=>{if(hasStarted){const retry=new URL(location);retry.searchParams.set('boot','1');location.replace(retry);return;}hasStarted=true;$('start').disabled=true;terminal.start(config);};
function update(){
  const label=$('shell-state').textContent,ready=!$('shell-in').disabled,phase=$('boot-transfer-phase').textContent,failed=$('shell-state').classList.contains('is-error');
  $('user-state').textContent=failed?'起動できません。診断を確認してください':ready
    ?label.includes('services failed')?'入力できます · サービスの初期化に失敗':'入力できます'
    :label.includes('idle')?(hasStarted?'Linuxを閉じました':'Linuxは未起動')
    :phase.includes('Saving')?'必要なデータを取得中':'Linuxを起動中';
  for(const id of ['send','list-linux'])$(id).disabled=!ready;
  $('compile').disabled=pendingRun!==null;
  if(ready&&pendingRun){const text=pendingRun;pendingRun=null;$('compile').disabled=false;$('compile').textContent='Run ↗';command(text);}
  if(failed&&pendingRun){pendingRun=null;$('compile').disabled=false;$('compile').textContent='Runを再試行';}
  if(failed){$('start').disabled=false;$('start').textContent='再試行';$('save-state').textContent='再試行はLinuxを起動し直します。編集ファイルと最後に保存したLinuxデータは保持されます。';}
  if(terminal.worker)wasRunning=true;
  if(wasRunning&&!terminal.worker&&label.includes('idle')){$('save-state').textContent='保存しました。このブラウザから再び起動できます。';wasRunning=false;}
}
new MutationObserver(update).observe($('shell-state'),{subtree:true,childList:true,attributes:true});
new MutationObserver(update).observe($('shell-in'),{attributes:true});
new MutationObserver(update).observe($('boot-transfer-phase'),{subtree:true,childList:true});
$('send').onclick=()=>{if(!$('shell-in').disabled)$('shell-in').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));};
$('clear').onclick=()=>{$('shell-out').replaceChildren();$('shell-in').focus();};
function command(text){choose('terminal');$('shell-in').value=text;$('send').click();}
function validName(s){return typeof s==='string'&&s.length>0&&s.length<=200&&!/[\/\\\u0000-\u001f]/.test(s)&&!['.','..'].includes(s);}
function save(){clearTimeout(timer);if(!validName($('filename').value)){$('editor-save').textContent='保存できません：名前に / や制御文字は使えません';return;}
  files[active]={name:$('filename').value,source:$('source').value};
  try{localStorage.setItem(key,JSON.stringify(files));$('editor-save').textContent='このブラウザに保存';}catch{$('editor-save').textContent='保存できません。Filesから書き出してください';}
  list();
}
try{const stored=JSON.parse(localStorage.getItem(key)||'null');if(Array.isArray(stored)&&stored.length&&stored.every(f=>validName(f.name)&&typeof f.source==='string'))files=stored;}catch{$('editor-save').textContent='保存を読み込めませんでした';}
if(!files.length)files=[{name:$('filename').value,source:$('source').value}];
function open(i){active=i;$('filename').value=files[i].name;$('source').value=files[i].source;choose('playground');}
function list(){const target=$('file-list'),rail=$('place-files');target.replaceChildren();rail.replaceChildren();files.forEach((f,i)=>{const row=document.createElement('div');row.className='file-row';
  const b=document.createElement('button');b.textContent=f.name;b.onclick=()=>{save();open(i);};const size=document.createElement('small');size.textContent=new TextEncoder().encode(f.source).length+' B · 編集ファイル';row.append(b,size);target.append(row);
  const rb=document.createElement('button');rb.textContent=f.name;rb.onclick=()=>{save();open(i);};rail.append(rb);});}
$('filename').value=files[0].name;$('source').value=files[0].source;list();
for(const id of ['source','filename'])$(id).oninput=()=>{clearTimeout(timer);$('editor-save').textContent='保存中…';timer=setTimeout(save,300);};
$('new-file').onclick=()=>{save();let n=files.length+1;while(files.some(f=>f.name===`file-${n}.c`))n++;files.push({name:`file-${n}.c`,source:''});open(files.length-1);save();};
$('export-files').onclick=()=>{save();const blob=new Blob([JSON.stringify({format:'length3-editor-files-v1',files},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='length3-editor-files.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('import-files').onchange=async e=>{try{const file=e.target.files[0];if(!file||file.size>4194304)throw new Error('4 MB以内の編集ファイル書き出しを選んでください');
  const parsed=JSON.parse(await file.text()),rows=Array.isArray(parsed)?parsed:parsed.files;
  if(!Array.isArray(rows)||!rows.length||!rows.every(f=>validName(f.name)&&typeof f.source==='string'))throw new Error('編集ファイルの名前と内容を確認してください');
  save();const next=files.map(f=>({...f}));for(const f of rows){let name=f.name,n=1;while(next.some(x=>x.name===name))name=`import-${n++}-${f.name}`;
    if(!validName(name))throw new Error('ファイル名が長すぎます');next.push({name,source:f.source});}
  localStorage.setItem(key,JSON.stringify(next));files=next;list();$('file-status').textContent=`${rows.length}ファイルをこのブラウザに保存しました。同名ファイルにはimportを付けています。`;
}catch(error){$('file-status').textContent='読み込めませんでした：'+error.message;}finally{e.target.value='';}};
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
$('compile').onclick=()=>{save();if(!validName($('filename').value))return;const name='/root/'+$('filename').value;
  const text=`printf %s ${quote($('source').value)} > ${quote(name)} && gcc ${quote(name)} -o /root/playground && /root/playground`;
  if(!$('shell-in').disabled){command(text);return;}
  if($('shell-state').classList.contains('is-error')){$('start').click();return;}
  pendingRun=text;$('compile').disabled=true;$('compile').textContent='起動してRun…';choose('terminal');
  if(!hasStarted)$('start').click();else if(!terminal.worker&&!$('btn-shell-resume').disabled)$('btn-shell-resume').click();};
$('list-linux').onclick=()=>command('ls -la /root');
$('rail-new').onclick=()=>$('new-file').click();
$('rail-terminal').onclick=()=>{choose('terminal');if(!$('shell-in').disabled)command('cd /root; ls -la');};
const shared=new URLSearchParams(location.hash.slice(1)).get('src');
if(shared){try{const bytes=Uint8Array.from(atob(shared),c=>c.charCodeAt(0)),source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  let n=1;while(files.some(f=>f.name===`shared-${n}.c`))n++;files.push({name:`shared-${n}.c`,source});open(files.length-1);save();}catch{$('file-status').textContent='共有リンクを読み込めませんでした';}}
addEventListener('pagehide',()=>{save();terminal.release();},{once:true});update();
if(new URL(location).searchParams.get('boot')==='1')$('start').click();

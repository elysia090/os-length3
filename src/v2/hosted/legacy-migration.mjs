// Read existing editor tabs on their original origin. No authority/key export.
const bar=document.createElement('div');bar.style.cssText='position:relative;padding:12px 24px;background:#f9f9fa;color:#15191e;font:13px sans-serif;display:flex;gap:16px;align-items:center;flex-wrap:wrap';
const info=document.createElement('span');info.textContent='旧qmの保存はこのoriginに残っています。新しいOSへ編集ファイルを持ち出せます。';
const button=document.createElement('button');button.textContent='編集ファイルを書き出す';button.style.cssText='min-height:44px;padding:8px 16px';
button.onclick=()=>{try{const tabs=JSON.parse(localStorage.getItem('qm.tabs')||'[]');
  if(!Array.isArray(tabs)||!tabs.length){info.textContent='保存された編集ファイルはありません。Linux内のデータは別の保存です。';return;}
  const files=tabs.map(t=>({name:t.name,source:t.source}));const url=URL.createObjectURL(new Blob([JSON.stringify({format:'length3-editor-files-v1',files},null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='qm-editor-files.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}catch{info.textContent='書き出せませんでした。このoriginのブラウザ保存状態を確認してください。';}};
const link=document.createElement('a');link.href='https://os.length3.com/';link.textContent='Length³ OSを開く ↗';link.style.color='#c2410c';
bar.append(info,button,link);document.body.prepend(bar);

import {browserModules} from 'ricebox/assets';
import {stripTypeScriptTypes} from 'node:module';
import {createHash} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkPresenter} from './presenter-pin.mjs';

function need(ok,name){if(!ok)throw Error(name)}
if(import.meta.main){
  const [checkout,site,elf,...extra]=process.argv.slice(2);
  need(checkout&&site&&elf&&!extra.length,'DISPLAY_STAGE_ARGUMENTS');
  const demo=join(site,'demo'),addon=join(demo,'display-fallback');
  const fixture=[
    ['ricebox/everyday/test/wayland/browser/raster-fixture.ts','7204507db8b3fbae14f3fa4729d02b180edd57da','raster-fixture.mjs'],
    ['ricebox/everyday/test/wayland/support/mirror-raster.ts','f53f8c9209be05af3c40b8ff9d111eded1c41afb','mirror-raster.mjs'],
  ].map(([src,blob,name])=>{
    const data=readFileSync(join(checkout,src));
    const got=createHash('sha1').update('blob '+data.length+'\0').update(data).digest('hex');
    need(blob===got,'EXACT_RASTER_SOURCE_MISMATCH');
    return [name,stripTypeScriptTypes(data.toString('utf8'),{mode:'transform'})];
  });
  const image=checkPresenter(elf);
  const shell=browserModules(),full=browserModules({display:true});
  need([...shell].every(([at,data])=>full.get(at)?.equals(data)&&readFileSync(join(demo,at)).equals(data)),
    'SHELL_MODULE_CHANGED_DURING_DISPLAY_STAGE');
  const additions=[...full].filter(([at])=>!shell.has(at));
  need(additions.length>0&&additions.every(([at])=>at.startsWith('ricebox-js/everyday/')),'UNEXPECTED_DISPLAY_MODULE_GRAPH');
  const html=readFileSync(join(demo,'index.html'),'utf8'),parts=html.split('</html>');
  need(parts.length===2,'UNEXPECTED_SHELL_HTML');
  mkdirSync(addon);
  for(const [at,data] of additions){const file=join(demo,at);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,data,{flag:'wx'})}
  for(const [at,data] of [...fixture,['wayland-presenter.bin',image]])writeFileSync(join(addon,at),data,{flag:'wx'});
  for(const f of ['display-page.mjs','wayland-contract.mjs'])writeFileSync(join(addon,f),readFileSync(fileURLToPath(new URL('./'+f,import.meta.url))),{flag:'wx'});
  const ui=`<button id="show-fallback" type="button">Show pinned Wayland control</button>
    <p id="fallback-state" role="status" data-phase="off">Display not loaded</p>
    <section id="fallback-ui" hidden>
    <div id="fallback-camera" style="overflow:auto;width:170px;height:125px;border:1px solid #777">
      <canvas style="display:block;image-rendering:pixelated"></canvas>
    </div>
    <button id="fallback-pan">Pan camera</button><button id="fallback-resize">Resize guest</button>
    <button id="fallback-quit">Close guest display</button></section>
    <pre id="fallback-protocol" hidden></pre>
    <script type="module">
      document.querySelector('#show-fallback').addEventListener('click',async event=>{
        event.target.disabled=true;
        try{await (await import('./display-fallback/display-page.mjs')).startDisplay()}
        catch(error){const s=document.querySelector('#fallback-state');s.dataset.phase='error';s.textContent=String(error)}
      },{once:true});
    </script>`;
  writeFileSync(join(demo,'index.html'),parts[0]+ui+'</html>'+parts[1]);
  console.log('RX_EVERYDAY_DISPLAY_STAGE pinned-musl-c-static');
}

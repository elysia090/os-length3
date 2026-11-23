// Real-only, non-product acceptance adapter. The installed root performs every
// browser fetch, verification and guest boot; this adapter has no preflight.
export const prompt = 'ricebox-accept$ ';
export function declaredRelease(text, base) {
  const declaration = JSON.parse(text);
  if (!declaration || Object.keys(declaration).length !== 1 || declaration.shell !== './ricebox/') {
    throw Error('Acceptance requires the shell-only declaration: {"shell":"./ricebox/"}');
  }
  return new URL(declaration.shell, base).href;
}
function box() {
  return {
    config: JSON.stringify({
      ociVersion: '1.0.2',
      process: {args: ['/usr/bin/busybox', 'sh', '-i'], cwd: '/', noNewPrivileges: true,
        env: ['PATH=/usr/bin:/bin', 'HOME=/', 'TERM=dumb', 'PS1='+prompt]},
      root: {path: '/', readonly: true},
      linux: {namespaces: ['pid', 'network', 'ipc', 'uts', 'mount', 'user'].map(type => ({type})),
        uidMappings: [{containerID: 0, hostID: 0, size: 1}], gidMappings: [{containerID: 0, hostID: 0, size: 1}]},
    }),
    words: ['run', '--lend', '/', '--ids', '0-0', '-b', '/run/box', 'shell'],
  };
}

export function launchDeclared({base, declaration, createRoot, attach, retire}) {
  const release = declaredRelease(declaration, base);
  const loader = createRoot({base: release, first: [], usedKey:'ricebox-accept-used', planKey:'ricebox-accept-plan',
    message: key=>key, missing: ()=>'Pinned ricebox layers are missing', errorText:String});
  let closed=false, worker;
  const ready=(async()=>{
    const loaded=await loader.execution.load();
    if (closed) return false;
    if (!loaded || loaded.profile!=='canonical-aot-v1' || !loaded.muk || !loaded.translator || loaded.url!==release) {
      throw Error('The pinned Ricebox root did not load the expected Muk, translator, and release URL');
    }
    worker=loader.rootWorker();
    attach(worker);
    worker.postMessage({type:'start', profile:loaded.profile, generation:loaded.generation,
      translator:loaded.translator, muk:loaded.muk, executables:loader.execution.executablesNow(loaded),
      root:{index:loaded.index,url:loaded.url}, box:box(), cwd:'/', screen:true});
    return true; // Worker admitted. This is NOT prompt readiness.
  })().catch(error=>{ close(); throw error; });
  function close() {
    if(closed) return;
    closed=true;
    if(worker) void retire(worker);
  }
  return {ready,close};
}

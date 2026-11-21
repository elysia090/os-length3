export function rasterStart(translator: Uint8Array, muk: Uint8Array, elf: Uint8Array) {
  const config=JSON.stringify({
    ociVersion:'1.0.2',
    process:{args:['/usr/bin/wayland-presenter','/proof'],cwd:'/',env:['LANG=C.UTF-8'],noNewPrivileges:true},
    root:{path:'/',readonly:true},
    mounts:[{destination:'/proof',type:'bind',source:'/proof-channel',options:['bind','rw','nosuid','nodev','noexec']}],
    linux:{
      namespaces:['pid','network','ipc','uts','mount','user'].map(type=>({type})),
      uidMappings:[{containerID:0,hostID:0,size:1}], gidMappings:[{containerID:0,hostID:0,size:1}],
    },
  });
  return {
    type:'start', translator, muk, cwd:'/', screen:false,
    box:{config,words:['run','--lend','/','--lend','/proof-channel','--ids','0-0','-b','/run/box','proof']},
    mirror:'/proof-channel',dirs:['/proof','/proof-channel'],files:[{path:'/usr/bin/wayland-presenter',bytes:elf,mode:0o755}],
  };
}

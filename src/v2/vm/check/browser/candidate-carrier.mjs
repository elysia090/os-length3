import {NetworkTransport} from '../../../web/network-transport.mjs';
const result=document.getElementById('result'),record={scope:'actual granted WebTransport handshake only',status:'connecting'};
let network;
try{const name=new URL(location.href).searchParams.get('config')??'qualification-network-config.json';
  if(!['qualification-network-config.json','qualification-network443-config.json','qualification-network4-config.json','qualification-network-relay-config.json','qualification-network-current-config.json'].includes(name))throw new Error('explicit fixture config');
  const config=await(await fetch('./'+name)).json();network=new NetworkTransport(config);
  await network.open(999n);record.status='pass';}
catch(e){Object.assign(record,{status:'fail',name:e.name,error:String(e.message).replace(/grant=[A-Za-z0-9_-]+/g,'grant=REDACTED'),
  source:e.source,streamErrorCode:e.streamErrorCode});}
finally{await network?.close();result.textContent=JSON.stringify(record,null,2);}

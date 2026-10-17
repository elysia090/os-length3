// Test-only, bounded opaque relay. TLS and guest Ethernet remain end to end.
// Run only with the disposable packet host's loopback TCP projection on 8088.
import {createSocket} from 'node:dgram';import {connect} from 'node:net';
const udp=createSocket('udp4'),peers=new Map();let total=0;
udp.on('message',(packet,from)=>{
 if(packet.length<1||packet.length>2048||++total>500000)return;
 const key=from.address+':'+from.port;let row=peers.get(key);
 if(!row){if(peers.size>=8)return;const tcp=connect(8088,'127.0.0.1');row={tcp,from,buffer:Buffer.alloc(0)};peers.set(key,row);
  tcp.on('data',bytes=>{row.buffer=Buffer.concat([row.buffer,bytes]);if(row.buffer.length>65536){tcp.destroy();return;}
    while(row.buffer.length>=4){const n=row.buffer.readUInt32BE();if(n<1||n>2048){tcp.destroy();return;}if(row.buffer.length<4+n)return;
      const body=row.buffer.subarray(4,4+n);udp.send(body,from.port,from.address);row.buffer=row.buffer.subarray(4+n);}});
  tcp.setTimeout(60000,()=>tcp.destroy());tcp.on('error',()=>{});tcp.on('close',()=>peers.delete(key));}
 if(row.tcp.writableLength>65536)return;const size=Buffer.alloc(4);size.writeUInt32BE(packet.length);row.tcp.write(Buffer.concat([size,packet]));
});
udp.bind(63700,'127.0.0.1',()=>console.log('Opaque bounded UDP/TCP test relay listening on loopback; TLS/guest packets unchanged'));
process.on('SIGINT',()=>{for(const row of peers.values())row.tcp.destroy();udp.close();});

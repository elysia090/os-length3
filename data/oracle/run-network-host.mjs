// Test deployment only. A verified, already-built disposable Linux oracle is
// the TAP/NAT host. It never executes the browser's guest CPU or rootfs.
import {createServer} from 'node:http';import {createReadStream,createWriteStream} from 'node:fs';import {createHash} from 'node:crypto';
import {realpath,stat,mkdir,readFile} from 'node:fs/promises';import {spawn,spawnSync} from 'node:child_process';import path from 'node:path';
const [qemuArg,diskArg,gatewayArg,helperArg,nftArg,workArg,...extra]=process.argv.slice(2);
if(!workArg||extra.some(x=>!['--fresh-base','--tcg'].includes(x))||new Set(extra).size!==extra.length)throw new Error('QEMU VERIFIED-ORACLE-DISK GATEWAY HELPER NFT NEW-WORK [--fresh-base] [--tcg]');
const [qemu,disk,gateway,helper,nft]=await Promise.all([qemuArg,diskArg,gatewayArg,helperArg,nftArg].map(p=>realpath(p)));
if(!disk.includes(`${path.sep}temp${path.sep}device-kernel-1010b${path.sep}oracle${path.sep}`))throw new Error('this test reuses only its verified, stopped build oracle');
const log=await readFile(path.join(path.dirname(disk),'serial.log'),'utf8');if(!log.includes('selfhost-oracle: pass'))throw new Error('completed independent oracle checkpoint required');
const work=path.resolve(workArg);if(!work.includes(`${path.sep}temp${path.sep}`))throw new Error('isolated scratch workspace');await mkdir(work);
let bootDisk=disk;
if(extra.includes('--fresh-base')){
 const lock=JSON.parse(await readFile(new URL('../bootstrap/windows.json',import.meta.url),'utf8')),
   image=await realpath(new URL('../upstream/bootstrap/'+lock.image.file,import.meta.url));
 const sha=createHash('sha256');for await(const bytes of createReadStream(image))sha.update(bytes);
 if(sha.digest('hex')!==lock.image.sha256)throw new Error('pinned stock oracle image');
 bootDisk=path.join(work,'network.qcow2');const made=spawnSync(path.join(path.dirname(qemu),'qemu-img.exe'),['create','-f','qcow2','-F','qcow2','-b',image,bootDisk,'4G'],{windowsHide:true,encoding:'utf8'});
 if(made.status!==0)throw new Error(made.stderr);
}
const files=new Map([['/gateway',gateway],['/helper',helper],['/nft',nft]]);
const requests=createWriteStream(path.join(work,'requests.log'),{flags:'wx'});
const script=`#!/bin/sh
set -eu
trap 'echo network-oracle-failed' EXIT
for role in gateway helper nft;do wget -qO /run/$role http://10.0.2.100/$role;chmod 755 /run/$role;done
exec /run/helper --isolated-test /run/gateway
`;
const server=createServer(async(req,res)=>{if(req.method!=='GET'){res.writeHead(405).end();return;}
 const route=new URL(req.url,'http://127.0.0.1').pathname;requests.write(`${req.method} ${route}\n`);
 if(route==='/seed/meta-data'){res.end('instance-id: length3-network-oracle-1011\nlocal-hostname: network-oracle\n');return;}
 if(route==='/seed/vendor-data'){res.end('#cloud-config\n{}\n');return;}
 if(route==='/seed/network-config'){res.end('version: 2\nethernets:\n  eth0:\n    dhcp4: true\n');return;}
 if(route==='/seed/user-data'){res.end('#cloud-config\nruncmd:\n  - [sh, -c, "wget -qO /run/network.sh http://10.0.2.100/run; sh /run/network.sh >/dev/ttyS0 2>&1"]\n');return;}
 if(route==='/run'){res.end(script);return;}const file=files.get(route);if(!file){res.writeHead(404).end();return;}
 const s=await stat(file);res.setHeader('Content-Length',s.size);const stream=createReadStream(file);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port,output=createWriteStream(path.join(work,'serial.log'),{flags:'wx'});
const child=spawn(qemu,['-L',path.join(path.dirname(qemu),'share'),'-machine','q35','-accel',extra.includes('--tcg')?'tcg':'whpx','-vga','none','-cpu','qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt,+cx16,-svm',
 '-m','4096','-smp','4','-drive',`file=${bootDisk.replaceAll('\\','/')},format=qcow2,if=virtio`,
 '-netdev',`user,id=n0,restrict=on,guestfwd=tcp:10.0.2.100:80-tcp:127.0.0.1:${port},hostfwd=udp:127.0.0.1:8445-:8445,hostfwd=tcp:127.0.0.1:8086-:8086`,
 '-netdev','user,id=outside,net=10.0.3.0/24,dhcpstart=10.0.3.15',
 '-device','virtio-net-pci,netdev=n0,mac=52:54:00:12:34:56','-device','virtio-net-pci,netdev=outside,mac=52:54:00:12:34:57',
 '-smbios','type=1,serial=ds=nocloud;s=http://10.0.2.100/seed/','-display','none','-monitor','none','-qmp','tcp:127.0.0.1:4446,server=on,wait=off','-serial','stdio','-no-reboot'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stdout.pipe(output,{end:false});child.stderr.pipe(output,{end:false});
console.log(JSON.stringify({pid:child.pid,control:'http://127.0.0.1:8086/config',gateway:'https://127.0.0.1:8445',scope:'disposable Linux TAP host; browser guest CPU remains C vm.wasm',log:path.join(work,'serial.log')}));
const close=()=>{child.kill();server.close();};process.on('SIGINT',close);process.on('SIGTERM',close);
await new Promise(r=>child.once('close',r));server.close();output.end();requests.end();

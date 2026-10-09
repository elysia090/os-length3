// Disposable independent Linux C oracle. No SSH credential, product backend,
// guest interpreter or release payload is created by this test harness.
import {spawn,spawnSync} from 'node:child_process';
import {createReadStream,createWriteStream} from 'node:fs';
import {readFile,stat,mkdir,realpath} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {finished} from 'node:stream/promises';
const repo=await realpath(fileURLToPath(new URL('../..',import.meta.url)));
const [qemuArg,imgArg,sourceArg,workArg,...extra]=process.argv.slice(2);
if(!workArg||extra.length)throw new Error('QEMU QEMU-IMG SOURCE-TAR NEW-WORK-DIRECTORY');
const work=path.resolve(workArg),temp=path.join(repo,'temp')+path.sep;
if(!work.startsWith(temp)||work===path.join(repo,'temp'))throw new Error('fresh oracle workspace below repository temp');
await mkdir(work); // Never replace an existing disk or diagnostic receipt.
const qemu=await realpath(qemuArg),img=await realpath(imgArg),source=await realpath(sourceArg);
const lock=JSON.parse(await readFile(path.join(repo,'data/bootstrap/windows.json'),'utf8'));
const upstream=path.join(repo,'data/upstream/bootstrap'),image=path.join(upstream,lock.image.file);
async function digest(file,algorithm){const h=createHash(algorithm);for await(const bytes of createReadStream(file))h.update(bytes);return h.digest('hex');}
if(await digest(image,'sha256')!==lock.image.sha256
    ||await digest(path.join(upstream,lock.qemu.file),'sha512')!==lock.qemu.sha512)throw new Error('pinned oracle input digest');
function run(program,args){const r=spawnSync(program,args,{windowsHide:true,encoding:'utf8'});
  if(r.error||r.status!==0)throw new Error(`${program}: ${r.error?.message??r.stderr}`);return r.stdout;}
const gpg=process.platform==='win32'?'C:/Program Files/GnuPG/bin/gpg.exe':'gpg';
const gnupg=path.join(work,'gnupg');await mkdir(gnupg);
run(gpg,['--homedir',gnupg,'--batch','--import',path.join(upstream,lock.image.key_file)]);
const signature=run(gpg,['--homedir',gnupg,'--batch','--status-fd','1','--verify',path.join(upstream,lock.image.signature),image]);
if(!signature.includes(`[GNUPG:] VALIDSIG ${lock.image.key_fingerprint} `))throw new Error('oracle image signer');
const disk=path.join(work,'oracle.qcow2');run(img,['create','-f','qcow2','-F','qcow2','-b',image,disk,'8G']);
const lines=(await readFile(path.join(repo,'data/bootstrap/packages.sha256'),'utf8')).trim().split(/\r?\n/);
const packages=new Map();
for(const line of lines){const m=/^([a-f0-9]{64})\s+\.\/([A-Za-z0-9_.+-]+\.apk)$/.exec(line);if(!m)throw new Error('pinned APK manifest');packages.set(m[2],m[1]);}
const sourceHash=await digest(source,'sha256');
const packageArchive=path.join(work,'packages.tar');
run('tar',['--format=ustar','-cf',packageArchive,'-C',path.join(upstream,'packages'),...packages.keys()]);
const transportLog=createWriteStream(path.join(work,'transport.log'),{flags:'wx'});
const script=`#!/bin/sh
set -eu
trap 'printf "\\nselfhost-oracle: failed\\n"' EXIT
printf 'selfhost-oracle: started\\n'
mkdir -p /build/source /build/bootstrap/packages
tar -xf /dev/vdb -C /build/source
tar -xf /dev/vdc -C /build/bootstrap/packages
cd /build/source
QM_BOOTSTRAP_WORK=/build/bootstrap sh data/bootstrap/install-tools.sh install
make -j4 -C src/v2/support all
make -j4 -C src/v2/x86 all
make -j4 -C src/v2/optimized-x86 all
make -j4 -C src/v2/postlink-compiler all check
make -j4 -C src/v2/wasm-compiler all packed-shift-check vector-unpack-check x87-control-check x87-environment-check
make -j4 -C src/v2/vm all check
bash src/v2/wasm-compiler/check/sanitizers.sh
trap - EXIT
printf '\\nselfhost-oracle: pass\\n'
`;
const server=createServer(async(req,res)=>{
  if(req.method!=='GET'){res.writeHead(405).end();return;}
  const url=new URL(req.url,'http://127.0.0.1'),route=url.pathname;
  transportLog.write(`${req.method} ${route}\n`);
  res.setHeader('Cache-Control','no-store');
  if(route==='/seed/meta-data'){res.end('instance-id: length3-isolated-c-oracle\nlocal-hostname: c-oracle\n');return;}
  if(route==='/seed/vendor-data'){res.end('#cloud-config\n{}\n');return;}
  if(route==='/seed/network-config'){res.end('version: 2\nethernets:\n  eth0:\n    dhcp4: true\n');return;}
  if(route==='/seed/user-data'){
    res.end('#cloud-config\ngrowpart:\n  mode: auto\n  devices: [\'/\']\nresize_rootfs: true\nruncmd:\n  - [sh, -c, "wget -qO /run/check.sh http://10.0.2.100/run; sh /run/check.sh >/dev/ttyS0 2>&1"]\n');return;}
  if(route==='/run'){res.end(script);return;}
  const name=route.startsWith('/packages/')?route.slice(10):null;
  const file=route==='/source.tar'?source:name&&packages.has(name)?path.join(upstream,'packages',name):null;
  if(!file){res.writeHead(404).end();return;}
  try{const s=await stat(file);res.setHeader('Content-Length',s.size);const stream=createReadStream(file);
    stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  }catch{res.writeHead(404).end();}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const port=server.address().port,log=createWriteStream(path.join(work,'serial.log'),{flags:'wx'});
const args=['-L',path.join(path.dirname(qemu),'share'),'-machine','q35','-accel','whpx','-cpu','qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt,+cx16,-svm',
  '-m','4096','-smp','4','-drive',`file=${disk.replaceAll('\\','/')},format=qcow2,if=virtio`,
  '-drive',`file=${source.replaceAll('\\','/')},format=raw,if=virtio,readonly=on`,
  '-drive',`file=${packageArchive.replaceAll('\\','/')},format=raw,if=virtio,readonly=on`,
  '-netdev',`user,id=n0,restrict=on,guestfwd=tcp:10.0.2.100:80-tcp:127.0.0.1:${port}`,
  '-device','virtio-net-pci,netdev=n0',
  '-smbios','type=1,serial=ds=nocloud;s=http://10.0.2.100/seed/','-display','none','-monitor','none','-serial','stdio','-no-reboot'];
const child=spawn(qemu,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
let tail='',outcome,bytes=0;const began=performance.now();
function stop(reason){if(outcome!==undefined)return;outcome=reason;child.kill();}
const timeout=setTimeout(()=>stop('independent C oracle timeout'),900000);
function consume(b){bytes+=b.length;log.write(b);tail=(tail+b.toString()).slice(-16384);
  if(bytes>64*1024*1024)stop('bounded oracle log exhausted');
  if(/(?:^|[\r\n])selfhost-oracle: failed\r?\n/.test(tail))stop('C gate failed');
  if(/(?:^|[\r\n])selfhost-oracle: pass\r?\n/.test(tail))stop(null);
  if(tail.includes('Kernel panic - not syncing'))stop('oracle kernel panic');}
child.stdout.on('data',consume);child.stderr.on('data',consume);child.once('error',e=>stop(e.message));
await new Promise(resolve=>child.once('close',(code,signal)=>{if(outcome===undefined)outcome=`oracle exited ${code}/${signal}`;resolve();}));
clearTimeout(timeout);server.close();log.end();transportLog.end();await Promise.all([finished(log),finished(transportLog)]);
console.log(JSON.stringify({format:'isolated-linux-c-oracle-v1',status:outcome===null?'pass':'fail',reason:outcome,
  imageSha256:lock.image.sha256,sourceSha256:sourceHash,accelerator:'WHPX',ssh:'none',network:'explicit loopback seed only; source/APKs are read-only block inputs; no outside routing',
  elapsedMs:performance.now()-began,logBytes:bytes,work,linuxBrowserBoot:'not-tested'},null,2));
if(outcome!==null)process.exitCode=1;

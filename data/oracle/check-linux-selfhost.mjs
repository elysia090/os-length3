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
import {zstdDecompressSync} from 'node:zlib';
import {seedImage} from './seed-image.mjs';
const repo=await realpath(fileURLToPath(new URL('../..',import.meta.url)));
const [qemuArg,imgArg,sourceArg,workArg,...extra]=process.argv.slice(2);
const observations=extra.includes('--observations'),rescue=extra.includes('--rescue-root'),kernel=extra.includes('--kernel'),initProfile=extra.includes('--init-profile'),candidate=extra.includes('--candidate-root'),publication=extra.includes('--publication');
const publicationOnly=extra.includes('--publication-only');
const guestCheckOption=extra.find(x=>x.startsWith('--guest-check='))?.slice(14);
const guestCheck=guestCheckOption?await realpath(guestCheckOption):null;
if(guestCheck&&(!guestCheck.startsWith(path.join(repo,'data','oracle')+path.sep)||extra.length!==1))throw new Error('one checked-in custom oracle gate');
const kernelInput=extra.find(x=>x.startsWith('--kernel-input='))?.slice(15),kernelPin=extra.find(x=>x.startsWith('--kernel-input-sha256='))?.slice(22);
if(!workArg||new Set(extra).size!==extra.length||extra.some(x=>!['--publication','--publication-only','--candidate-root','--init-profile','--kernel','--rescue-root','--observations'].includes(x)&&!x.startsWith('--guest-check=')&&!x.startsWith('--kernel-input=')&&!x.startsWith('--kernel-input-sha256='))||candidate&&!publication||publicationOnly&&!publication||initProfile&&!candidate||kernel&&!initProfile||(rescue||observations)&&extra.length!==1
    ||['--kernel-input=','--kernel-input-sha256='].some(prefix=>extra.filter(x=>x.startsWith(prefix)).length>1)
    ||!!kernelInput!==!!kernelPin||kernelInput&&(!initProfile||kernel||!/^[a-f0-9]{64}$/.test(kernelPin)))
  throw new Error('QEMU QEMU-IMG SOURCE-TAR NEW-WORK-DIRECTORY [--publication [--candidate-root [--init-profile [--kernel]]]] | --rescue-root | --observations');
const work=path.resolve(workArg),temp=path.join(repo,'temp')+path.sep;
if(!work.startsWith(temp)||work===path.join(repo,'temp'))throw new Error('fresh oracle workspace below repository temp');
await mkdir(work); // Never replace an existing disk or diagnostic receipt.
const qemu=await realpath(qemuArg),img=await realpath(imgArg),source=await realpath(sourceArg);
const lock=JSON.parse(await readFile(path.join(repo,'data/bootstrap/windows.json'),'utf8'));
const upstream=path.join(repo,'data/upstream/bootstrap'),image=path.join(upstream,lock.image.file);
async function digest(file,algorithm){const h=createHash(algorithm);for await(const bytes of createReadStream(file))h.update(bytes);return h.digest('hex');}
if(await digest(image,'sha256')!==lock.image.sha256
    ||await digest(path.join(upstream,lock.qemu.file),'sha512')!==lock.qemu.sha512)throw new Error('pinned oracle input digest');
function run(program,args){
  // The Windows archive reader accepts drive-letter paths literally. GNU tar
  // found earlier on PATH can instead parse C: as a remote archive host.
  if(program==='tar'&&process.platform==='win32')program=path.join(process.env.SystemRoot??'C:/Windows','System32','tar.exe');
  const r=spawnSync(program,args,{windowsHide:true,encoding:'utf8'});
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
const sourceOptions=[];let kernelSourceBytes=0;
if(observations){const directory=path.join(work,'observations');await mkdir(directory);
  sourceOptions.push('-drive',`file=fat:rw:${directory.replaceAll('\\','/')},format=raw,if=virtio`);}
if(rescue){const file=path.join(repo,'temp/isolated-kernel-1010m/candidate-files/system.squashfs');
  if(await digest(file,'sha256')!=='f971b50b806cb226172d88afbd6b45258da1cf7a89b1472e067f58006d29d280')throw new Error('rebuilt diagnostic root identity');
  const directory=path.join(work,'candidate-files');await mkdir(directory);
  sourceOptions.push('-drive',`file=${file.replaceAll('\\','/')},format=raw,if=virtio,readonly=on`,
    '-drive',`file=fat:rw:${directory.replaceAll('\\','/')},format=raw,if=virtio`);}
if(publication){const inputs=await readFile(path.join(repo,'data/sources.env'),'utf8');
  for(const [role,extension] of [['TAR','tar.xz'],['BUSYBOX','tar.bz2']]){
    const version=new RegExp(`^${role}_VERSION=([0-9.]+)$`,'m').exec(inputs)?.[1],sha=new RegExp(`^${role}_SHA256=([a-f0-9]{64})$`,'m').exec(inputs)?.[1];
    if(!version||!sha)throw new Error('pinned userland source identity');
    const file=path.join(repo,'data/upstream',`${role.toLowerCase()}-${version}.${extension}`);
    if(await digest(file,'sha256')!==sha)throw new Error('userland source digest');
    sourceOptions.push('-drive',`file=${file.replaceAll('\\','/')},format=raw,if=virtio,readonly=on`);
  }
}
if(candidate){for(const [name,sha] of [['system.squashfs','6c7f0ea12300984eb1f9e9d4e33eef2be8db642e22afa9f776342a17a888bda9'],['initramfs','90ad6681efc64bbbf5d10b92ac3aa62cc12eafc6dc88b790cec055a4bffb4ff1']]){
  const file=path.join(repo,'temp/native-delivery-boot-1a0bddc2340a',name);if(await digest(file,'sha256')!==sha)throw new Error('frozen candidate base identity');
  sourceOptions.push('-drive',`file=${file.replaceAll('\\','/')},format=raw,if=virtio,readonly=on`);
}}
if(candidate){const directory=path.join(work,'candidate-files');await mkdir(directory);
  sourceOptions.push('-drive',`file=fat:rw:${directory.replaceAll('\\','/')},format=raw,if=virtio`);}
if(initProfile){const lockText=await readFile(path.join(repo,'data/sources.env'),'utf8'),names=[];
  for(const [role,name] of [['SKALIBS','skalibs'],['EXECLINE','execline'],['S6','s6'],['S6_RC','s6-rc'],['MDEVD','mdevd']]){
    const version=new RegExp(`^${role}_VERSION=([0-9.]+)$`,'m').exec(lockText)?.[1],sha=new RegExp(`^${role}_SHA512=([a-f0-9]{128})$`,'m').exec(lockText)?.[1];
    if(!version||!sha)throw new Error('locked init source');const file=`${name}-${version}.tar.gz`;
    if(await digest(path.join(repo,'data/upstream',file),'sha512')!==sha)throw new Error('init source digest');names.push(file);
  }
  const archive=path.join(work,'init-inputs.tar');run('tar',['--format=ustar','-cf',archive,'-C',path.join(repo,'data/upstream'),...names]);
  sourceOptions.push('-drive',`file=${archive.replaceAll('\\','/')},format=raw,if=virtio,readonly=on`);
}
if(kernel){const lockText=await readFile(path.join(repo,'data/sources.env'),'utf8'),version=/^LINUX_VERSION=([0-9.]+)$/m.exec(lockText)?.[1],sha=/^LINUX_SHA256=([a-f0-9]{64})$/m.exec(lockText)?.[1];
  if(!version||!sha)throw new Error('locked kernel source');const file=path.join(repo,'data/upstream',`linux-${version}.tar.xz`);
  if(await digest(file,'sha256')!==sha)throw new Error('kernel source digest');kernelSourceBytes=(await stat(file)).size;
  sourceOptions.push('-drive',`file=${file.replaceAll('\\','/')},format=raw,if=virtio,readonly=on`);
}
let kernelInputBytes=0;
if(kernelInput){const file=await realpath(kernelInput);if(await digest(file,'sha256')!==kernelPin)throw new Error('explicit accepted kernel checkpoint identity');
  kernelInputBytes=(await stat(file)).size;if(kernelInputBytes<4096||kernelInputBytes>16777216)throw new Error('bounded accepted kernel checkpoint');
  sourceOptions.push('-drive',`file=${file.replaceAll('\\','/')},format=raw,if=virtio,readonly=on`);}
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
${guestCheck?`make -j4 -C src/v2/postlink-compiler all
sh ${path.relative(repo,guestCheck).replaceAll('\\','/')}`:publicationOnly?'make -j4 -C src/v2/postlink-compiler all':`make -j4 -C src/v2/support all
make -j4 -C src/v2/x86 all vector-projection-check
make -j4 -C src/v2/optimized-x86 all
make -j4 -C src/v2/postlink-compiler all check
bash src/v2/postlink-compiler/check/sanitizers.sh
make -j4 -C src/v2/wasm-compiler all packed-binary-check packed-shift-check vector-unpack-check vector-select-check vector-widen-check masked-store-check profile-additions-check compensated-check angle-check x87-control-check x87-environment-check float-arithmetic-check float-round-check float-sqrt-check float-compare-check scalar-vector-transfer-check
make -j4 -C src/v2/x86 crc32-check
make -j4 -C src/v2/vm all check
bash src/v2/vm/check/sanitizers.sh`}
export LENGTH3_KERNEL_SOURCE_BYTES=${kernelSourceBytes}
export LENGTH3_KERNEL_INPUT_BYTES=${kernelInputBytes}
export LENGTH3_KERNEL_INPUT_SHA256=${kernelPin??''}
${publication?`sh data/oracle/check-userland-publication.sh ${candidate?'--candidate-root':''} ${initProfile?'--init-profile':''} ${kernel?'--kernel':''}`:''}
${rescue?'sh data/oracle/prepare-rescue-root.sh':''}
${publicationOnly||guestCheck?'':'bash src/v2/wasm-compiler/check/sanitizers.sh'}
${observations?`mkdir -p /run/observations
mkdir /run/observations/paired
make -C src/v2/wasm-compiler build/paired-exchange-check
src/v2/wasm-compiler/build/paired-exchange-check /run/observations/paired
tar -cf /run/paired.tar -C /run/observations paired
mkdir /run/observation-transport
output_device=/dev/vdd1; test -b "$output_device" || output_device=/dev/vdd
mount -t vfat "$output_device" /run/observation-transport
cp /run/paired.tar /run/observation-transport/paired.tar
printf 'oracle-observations paired.tar %s %s\\n' "$(wc -c </run/paired.tar | tr -d ' ')" "$(sha256sum /run/paired.tar | cut -d ' ' -f 1)"
sync
umount /run/observation-transport
printf 'selfhost-oracle: paired observations exported\\n'`:''}
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
const seed=await seedImage(work,script,'length3-offline-c-oracle');
const args=['-L',path.join(path.dirname(qemu),'share'),'-machine','q35','-accel','whpx','-cpu','qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt,+cx16,-svm',
  '-m','4096','-smp','4','-drive',`file=${disk.replaceAll('\\','/')},format=qcow2,if=virtio`,
  '-drive',`file=${source.replaceAll('\\','/')},format=raw,if=virtio,readonly=on`,
  '-drive',`file=${packageArchive.replaceAll('\\','/')},format=raw,if=virtio,readonly=on`,
  ...sourceOptions,
  '-drive',`file=${seed.replaceAll('\\','/')},media=cdrom,format=raw,if=ide,readonly=on`,
  '-netdev',`user,id=n0,restrict=on,guestfwd=tcp:10.0.2.100:80-tcp:127.0.0.1:${port}`,
  '-device','virtio-net-pci,netdev=n0',
  '-vga','none','-display','none','-monitor','none','-serial','stdio','-no-reboot'];
const child=spawn(qemu,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
let tail='',outcome,bytes=0;const began=performance.now();
let receiptName=null,receiptHash=null,receiptLines='',partial='',observationReceipt=null;const receipts=[],candidateReceipts=new Map();
function receiveReceipts(chunk){if(!publication&&!rescue&&!observations&&!guestCheck)return;partial+=chunk.toString();let end;
  while((end=partial.indexOf('\n'))>=0){const line=partial.slice(0,end).replace(/\r$/, '');partial=partial.slice(end+1);
    const observation=/^oracle-observations paired\.tar ([0-9]+) ([a-f0-9]{64})$/.exec(line);
    if(observation){if(!observations||observationReceipt)throw new Error('one observation archive owner');
      observationReceipt={bytes:Number(observation[1]),sha256:observation[2]};continue;}
    const object=/^oracle-candidate (kernel|linux\.config|initramfs|system\.squashfs) ([0-9]+) ([a-f0-9]{64})$/.exec(line);
    if(object){if((!candidate&&!rescue)||candidateReceipts.has(object[1]))throw new Error('candidate role ownership');
      candidateReceipts.set(object[1],{bytes:Number(object[2]),sha256:object[3]});continue;}
    const begin=/^oracle-elf-begin (busybox-input|busybox-optimized|tar-input|tar-optimized|su-input|su-optimized|dhcpcd-input|dhcpcd-optimized|trace-userland|table-call-input|table-call-broken) ([a-f0-9]{64})$/.exec(line);
    if(begin){if(receiptName)throw new Error('nested ELF receipt');receiptName=begin[1];receiptHash=begin[2];receiptLines='';continue;}
    if(line==='oracle-elf-end'){
      if(!receiptName)throw new Error('unowned ELF receipt');
      const payload=zstdDecompressSync(Buffer.from(receiptLines,'base64'),{maxOutputLength:32*1024*1024});
      if(payload.subarray(0,4).toString('hex')!=='7f454c46'||createHash('sha256').update(payload).digest('hex')!==receiptHash)throw new Error('authenticated ELF receipt');
      const stream=createWriteStream(path.join(work,receiptName+'.elf'),{flags:'wx'});stream.end(payload);receipts.push(finished(stream));
      transportLog.write(`ELF ${receiptName} ${payload.length} ${createHash('sha256').update(payload).digest('hex')}\n`);receiptName=null;receiptLines='';continue;}
    if(receiptName){if(!/^[A-Za-z0-9+/=]+$/.test(line)||receiptLines.length+line.length>45*1024*1024)throw new Error('malformed ELF receipt');receiptLines+=line;}
  }
}
function stop(reason){if(outcome!==undefined)return;outcome=reason;child.kill();}
const timeout=setTimeout(()=>stop('independent C oracle timeout'),kernel?2100000:900000);
function consume(b){bytes+=b.length;log.write(b);try{receiveReceipts(b);}catch(e){stop(e.message);}tail=(tail+b.toString()).slice(-16384);
  if(bytes>64*1024*1024)stop('bounded oracle log exhausted');
  if(/(?:^|[\r\n])selfhost-oracle: failed\r?\n/.test(tail))stop('C gate failed');
  if(/(?:^|[\r\n])selfhost-oracle: pass\r?\n/.test(tail))stop(null);
  if(tail.includes('Kernel panic - not syncing'))stop('oracle kernel panic');}
child.stdout.on('data',consume);child.stderr.on('data',consume);child.once('error',e=>stop(e.message));
await new Promise(resolve=>child.once('close',(code,signal)=>{if(outcome===undefined)outcome=`oracle exited ${code}/${signal}`;resolve();}));
clearTimeout(timeout);server.close();log.end();transportLog.end();await Promise.all([finished(log),finished(transportLog),...receipts]);
const candidateOutput={};
if(outcome===null&&observations){try{
  const directory=path.join(work,'observations'),archive=path.join(directory,'paired.tar'),role=observationReceipt;
  if(!role||!Number.isSafeInteger(role.bytes)||role.bytes<1||role.bytes>64*1024*1024
      ||(await stat(archive)).size!==role.bytes||await digest(archive,'sha256')!==role.sha256)throw new Error('observation readback identity');
  const names=run('tar',['-tf',archive]).trim().split(/\r?\n/),expected=['paired/'];
  for(let i=0;i<72;++i)for(const suffix of ['json','source-page','cases','faults','wasm'])expected.push(`paired/paired-exchange-${i}.${suffix}`);
  if(new Set(names).size!==names.length||JSON.stringify([...names].sort())!==JSON.stringify(expected.sort()))throw new Error('complete observation archive population');
  const types=run('tar',['-tvf',archive]).trim().split(/\r?\n/);
  if(types.length!==names.length||types.some(line=>line[0]!=='-'&&line[0]!=='d'))throw new Error('observation archive regular entries only');
  run('tar',['-xf',archive,'-C',directory]);
}catch(e){outcome=e.message;}}
if(outcome===null&&(candidate||rescue)){try{for(const name of rescue?['system.squashfs']:kernel?['kernel','linux.config','initramfs','system.squashfs']:kernelInput?['kernel','initramfs','system.squashfs']:['initramfs','system.squashfs']){
  const role=candidateReceipts.get(name),file=path.join(work,'candidate-files',name);
  if(!role||!Number.isSafeInteger(role.bytes)||role.bytes<1||role.bytes>128*1024*1024||(await stat(file)).size!==role.bytes||await digest(file,'sha256')!==role.sha256)throw new Error('candidate readback identity');
  candidateOutput[name]=role;
}}catch(e){outcome=e.message;}}
console.log(JSON.stringify({format:'isolated-linux-c-oracle-v1',status:outcome===null?'pass':'fail',reason:outcome,
  imageSha256:lock.image.sha256,sourceSha256:sourceHash,accelerator:'WHPX',ssh:'none',network:'explicit loopback seed only; source/APKs are read-only block inputs; no outside routing',
  elapsedMs:performance.now()-began,logBytes:bytes,work,candidateOutput,
  cCoreTests:guestCheck?'custom-checked-in-gate':publicationOnly?'not-run-publication-only':'full-C-and-sanitizers',
  ...(guestCheck?{guestCheck:path.relative(repo,guestCheck).replaceAll('\\','/')}:{ }),
  ...(observations?{observations:path.join(work,'observations','paired'),observationReceipt,
    observationScope:'native paired-exchange CPU/fault/RAM and current native-C emission; NOT browser acceptance'}:{}),linuxBrowserBoot:'not-tested'},null,2));
if(outcome!==null)process.exitCode=1;

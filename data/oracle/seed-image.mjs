// Offline NoCloud seed. No credentials, SSH, network or product bytes enter
// this image; the already authorized test script runs on the isolated oracle.
import {mkdir,writeFile} from 'node:fs/promises';import {spawnSync} from 'node:child_process';import path from 'node:path';
export async function seedImage(work,script,instance){
 if(!/^[a-z0-9-]{1,80}$/.test(instance)||!work.includes(`${path.sep}temp${path.sep}`))throw new Error('isolated seed scope');
 const directory=path.join(work,'seed');await mkdir(directory);
 const content='#cloud-config\ngrowpart:\n  mode: auto\n  devices: [\'/\']\nresize_rootfs: true\nwrite_files:\n  - path: /run/check.sh\n    permissions: "0700"\n    content: |\n'+script.trimEnd().split('\n').map(l=>'      '+l).join('\n')+'\nruncmd:\n  - [sh, -c, "sh /run/check.sh >/dev/ttyS0 2>&1"]\n';
 await writeFile(path.join(directory,'user-data'),content,{flag:'wx'});
 await writeFile(path.join(directory,'meta-data'),`instance-id: ${instance}\nlocal-hostname: c-oracle\n`,{flag:'wx'});
 const image=path.join(work,'seed.iso'),run=spawnSync('tar',['--format=iso9660','--options=iso9660:volume-id=cidata','-cf',image,'-C',directory,'user-data','meta-data'],{windowsHide:true,encoding:'utf8'});
 if(run.status!==0)throw new Error(run.stderr);return image;
}

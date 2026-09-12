// Build-host plumbing only. No part of this host enters the release payload.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync,
  writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const work = join(repo, 'temp/bootstrap');
const inputs = join(repo, 'data/upstream/bootstrap');
const lock = JSON.parse(readFileSync(join(here, 'windows.json'), 'utf8'));
const qemu = join(work, 'qemu');
const image = join(inputs, lock.image.file);
const disk = join(work, 'build-host.qcow2');
const key = join(work, 'id_ed25519');
const port = 18081;
let buildPasswordHash;

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: repo, windowsHide: true, stdio: 'inherit', ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} exited ${result.status}`);
  return result.stdout;
}

async function verify(file, algorithm, expected) {
  const hash = createHash(algorithm);
  for await (const part of createReadStream(file)) hash.update(part);
  if (hash.digest('hex') !== expected) throw new Error(`checksum mismatch: ${file}`);
}

async function prepare() {
  mkdirSync(work, { recursive: true });
  await verify(join(inputs, lock.qemu.file), 'sha512', lock.qemu.sha512);
  await verify(image, 'sha256', lock.image.sha256);
  const gpgHome = join(work, 'gnupg');
  mkdirSync(gpgHome, { recursive: true });
  const gpg = process.env.QM_GPG || 'C:/Program Files/GnuPG/bin/gpg.exe';
  run(gpg, ['--homedir', gpgHome, '--batch', '--import', join(inputs, lock.image.key_file)]);
  const signature = run(gpg, ['--homedir', gpgHome, '--batch', '--status-fd', '1',
    '--verify', join(inputs, lock.image.signature), image],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (!signature.includes(`[GNUPG:] VALIDSIG ${lock.image.key_fingerprint} `)) {
    throw new Error('cloud image signer differs from the pinned official key');
  }
  if (!existsSync(join(qemu, 'qemu-system-x86_64.exe'))) {
    run('7z.exe', ['x', '-y', '-bso0', '-bsp0', `-o${qemu}`,
      join(inputs, lock.qemu.file), 'qemu-system-x86_64.exe', 'qemu-img.exe', '*.dll',
      'share/bios*.bin', 'share/kvmvapic.bin', 'share/linuxboot*.bin',
      'share/multiboot*.bin', 'share/vgabios*.bin', 'share/efi-virtio.rom',
      'share/keymaps/*', 'COPYING', 'COPYING.LIB', 'VERSION']);
  }
  if (!existsSync(key)) {
    run('ssh-keygen.exe', ['-q', '-t', 'ed25519', '-N', '', '-C', 'local-build-host', '-f', key]);
  }
  // Reuse the existing disk: never silently reset a build checkpoint.
  if (!existsSync(disk)) {
    run(join(qemu, 'qemu-img.exe'), ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', image, disk, '64G']);
  }
  const info = JSON.parse(run(join(qemu, 'qemu-img.exe'), ['info', '--output=json', disk],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
  if (resolve(info['full-backing-filename']) !== image) {
    throw new Error('existing checkpoint has a different backing image');
  }
  console.log(`build disk: ${disk}`);
}

function seed(name) {
  if (name === 'meta-data') return 'instance-id: local-build-host-v2\nlocal-hostname: build-host\n';
  if (name === 'vendor-data') return '#cloud-config\n{}\n';
  if (name === 'network-config') return 'version: 2\nethernets:\n  eth0:\n    dhcp4: true\n';
  if (name !== 'user-data') return null;
  const publicKey = readFileSync(`${key}.pub`, 'utf8').trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+ local-build-host$/.test(publicKey)) {
    throw new Error('unexpected ephemeral build-host public key');
  }
  return `#cloud-config
disable_root: false
ssh_pwauth: false
users:
  - name: root
    lock_passwd: false
    hashed_passwd: '${buildPasswordHash}'
    ssh_authorized_keys:
      - ${publicKey}
growpart:
  mode: auto
  devices: ['/']
resize_rootfs: true
write_files:
  - path: /etc/ssh/sshd_config.d/90-build-host.conf
    permissions: '0644'
    content: |
      PasswordAuthentication no
      KbdInteractiveAuthentication no
      AuthenticationMethods publickey
`;
}

function streamFile(res, file) {
  const stream = createReadStream(file);
  stream.on('error', () => { res.statusCode = 404; res.end(); });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function snapshot() {
  const archive = join(work, 'source.tar');
  run('tar.exe', ['-C', repo, '-cf', archive, '--exclude=.git', '--exclude=upstream',
    '--exclude=build', '--exclude=*/build-*/*', '--exclude=node_modules', '--exclude=dist',
    '--exclude=gmon.out', '--exclude=web', 'data', 'src/v2']);
  const names = new Set(run('tar.exe', ['-tf', archive],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 8 * 1024 * 1024 })
    .split(/\r?\n/));
  for (const entry of ['data/build.sh', 'data/build-linked-kernel.sh',
    'data/toolchain/build.sh', 'data/distribution/build-init.sh',
    'data/distribution/build-core-tools.sh', 'data/distribution/build-system-tools.sh',
    'data/bootstrap/build-native.sh', 'data/bootstrap/environment.sh']) {
    if (!names.has(entry)) throw new Error(`source snapshot omitted ${entry}`);
  }
  if ([...names].some(name => /\/(?:build|upstream|temp|\.git)\//.test(name))) {
    throw new Error('source snapshot contains an excluded generated/input tree');
  }
  return archive;
}

function serve() {
  // Alpine/OpenSSH rejects public keys too when the account is locked.
  // Keep the account unlocked with an unretained random password; SSH still
  // allows public-key authentication only. No shared/default password exists.
  buildPasswordHash = run(process.env.QM_OPENSSL || 'C:/msys64/ucrt64/bin/openssl.exe',
    ['passwd', '-6', '-stdin'], { input: randomBytes(48).toString('hex') + '\n',
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }).trim();
  // Preserve POSIX paths and symlinks in the guest, without expanding source
  // archives or copying generated trees on the Windows filesystem.
  const archive = snapshot();
  const upstream = join(repo, 'data/upstream');
  const names = new Set(readdirSync(upstream, { withFileTypes: true })
    .filter(e => e.isFile() && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(e.name)
      && !e.name.endsWith('.part')).map(e => e.name));
  const server = createServer((req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    // Exact routes, no directory listing or filesystem path interpretation.
    const path = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('Cache-Control', 'no-store');
    if (path.startsWith('/seed/')) {
      const data = seed(path.slice(6));
      if (data !== null) { res.end(data); return; }
    } else if (path === '/source.tar') {
      streamFile(res, archive); return;
    } else if (path === '/upstream-index') {
      res.end([...names].sort().join('\n') + '\n'); return;
    } else if (path.startsWith('/upstream/') && names.has(path.slice(10))) {
      streamFile(res, join(upstream, path.slice(10))); return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, '127.0.0.1', () => console.log(`build inputs: http://127.0.0.1:${port}`));
}

function boot() {
  const accelerator = process.argv[3];
  if (!['whpx', 'tcg'].includes(accelerator)) throw new Error('boot requires explicit whpx or tcg');
  const args = ['-L', join(qemu, 'share'), '-machine', 'q35', '-accel', accelerator,
    '-cpu', 'qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt,+cx16,-svm', '-m', '8192', '-smp', '6',
    '-drive', `file=${disk.replaceAll('\\', '/')},format=qcow2,if=virtio`,
    '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:18022-:22',
    '-device', 'virtio-net-pci,netdev=net0',
    '-smbios', `type=1,serial=ds=nocloud;s=http://10.0.2.2:${port}/seed/`,
    '-qmp', 'tcp:127.0.0.1:18082,server=on,wait=off',
    '-display', 'none', '-monitor', 'none', '-serial', 'stdio', '-no-reboot'];
  writeFileSync(join(work, 'execution.json'), JSON.stringify({ accelerator,
    machine: 'q35', cpus: 6, memory_mib: 8192, purpose: 'build-host-not-product', args }, null, 2) + '\n');
  const child = spawn(join(qemu, 'qemu-system-x86_64.exe'), args,
    { cwd: repo, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}

switch (process.argv[2]) {
  case 'prepare': await prepare(); break;
  case 'serve': serve(); break;
  case 'snapshot': console.log(snapshot()); break;
  case 'boot': boot(); break;
  default: throw new Error('usage: node data/bootstrap/windows.mjs prepare|serve|boot <whpx|tcg>');
}

// QEMU is an external test oracle, never a dependency of the native payload.
// With no system image this is only an isolated kernel/shell probe. Full mode
// requires the installed root, actual service state and native development.
import { spawn } from 'node:child_process';
import { createWriteStream, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { finished } from 'node:stream/promises';

const [qemuArg,kernelArg,initArg,outputArg,...options]=process.argv.slice(2);
const systemArg=options[0]&&!options[0].startsWith('--')?options.shift():undefined;
if (!outputArg||options.some(x=>!x.startsWith('--guest-file=')&&!x.startsWith('--guest-check=')&&!x.startsWith('--source=')&&!x.startsWith('--accel=')&&!x.startsWith('--packet-carrier=')&&!['--network','--network-tools'].includes(x))
    ||['--source=','--accel=','--guest-check='].some(prefix=>options.filter(x=>x.startsWith(prefix)).length>1)) {
  console.error('usage: node check-native-boot.mjs QEMU KERNEL INITRAMFS OUTPUT-LOG [SYSTEM-SQUASHFS] [--source=SOURCE-TAR] [--guest-check=SCRIPT] [--guest-file=FILE ...] [--accel=tcg|whpx] [--network|--network-tools]');
  process.exit(2);
}
const [qemu, kernel, initramfs] = [qemuArg,kernelArg,initArg].map(path => realpathSync(path));
const system = systemArg === undefined ? undefined : realpathSync(systemArg);
const sourceOption=options.find(x=>x.startsWith('--source=')),source=sourceOption?realpathSync(sourceOption.slice(9)):undefined;
const accelerator=options.find(x=>x.startsWith('--accel='))?.slice(8)??'tcg';
if(!['tcg','whpx'].includes(accelerator)||source&&!system)throw new Error('explicit native oracle accelerator/source domain');
const fullSystem = system !== undefined;
const guestCheckPath=options.find(x=>x.startsWith('--guest-check='))?.slice(14);
const guestCheck=guestCheckPath?readFileSync(realpathSync(guestCheckPath)):null;
if(guestCheck&&(!fullSystem||guestCheck.length>16384))throw new Error('bounded normal-boot guest check');
const guestFiles=options.filter(x=>x.startsWith('--guest-file=')).map(x=>{
  const file=realpathSync(x.slice(13)),name=file.replaceAll('\\','/').split('/').at(-1),bytes=readFileSync(file);
  if(!guestCheck||!/^[A-Za-z0-9_.-]+$/.test(name)||bytes.length<1||bytes.length>16384)throw new Error('bounded test-only guest input');
  return {name,bytes};
});
if(new Set(guestFiles.map(x=>x.name)).size!==guestFiles.length||guestFiles.reduce((n,x)=>n+x.bytes.length,0)>65536)
  throw new Error('unique bounded guest file population');
const network = options.includes('--network');
const networkTools = network || options.includes('--network-tools');
const packetCarrier=options.find(x=>x.startsWith('--packet-carrier='))?.slice(17);
if(packetCarrier&&(!network||packetCarrier!=='127.0.0.1:8090'))throw new Error('explicit independent loopback packet carrier');
if (networkTools && !fullSystem) throw new Error('network oracle requires installed root');
let append = 'console=ttyS0,115200n8 earlyprintk=serial nokaslr rdinit=/init panic=-1';
// The independent microvm oracle fixes its MMIO bus explicitly; firmware
// auto-command-line is not assumed. Product C device addresses are separate.
if (network) append += ' virtio_mmio.device=512@0xfeb00000:5';
const systemOptions = [];
if (fullSystem) {
  const bytes = statSync(system).size;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 0x10000000) {
    throw new Error('system image extent is outside the oracle contract');
  }
  const extent = `0x${bytes.toString(16)}`;
  // Match boot-qemu.sh's immutable physical-memory device. Linux mounts and
  // interprets the filesystem; the test adapter supplies only its bytes.
  append += ` memmap=${extent}$0x30000000 phram.phram=system,0x30000000,${extent}`;
  systemOptions.push('-device', `loader,file=${system},addr=0x30000000,force-raw=on`);
}
let sourceExtent;
if(source){const bytes=statSync(source).size;
  if(!Number.isSafeInteger(bytes)||bytes<1||bytes>67108864)throw new Error('bounded read-only test-source extent');
  sourceExtent=`0x${(Math.ceil(bytes/4096)*4096).toString(16)}`;
  append+=` memmap=${sourceExtent}$0x38000000`;
  systemOptions.push('-device',`loader,file=${source},addr=0x38000000,force-raw=on`);
}
const output = resolve(outputArg);
realpathSync(dirname(output));
const log = createWriteStream(output, { flags: 'wx' });
await new Promise((resolve, reject) => {
  log.once('open', resolve);
  log.once('error', reject);
});
const cpu = 'qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt,+cx16,-xsave,-avx,-aes,-pclmulqdq,-monitor';
const started = performance.now();
const args = [
  '-machine', `${network?'microvm,acpi=off,ioapic2=off,pcie=off,pic=on,pit=on,rtc=on':'pc'},accel=${accelerator}`, '-cpu', cpu, '-m', fullSystem ? '1024M' : '512M', '-smp', '1',
  '-kernel', kernel, '-initrd', initramfs,
  '-append', append, ...systemOptions,
  '-nodefaults', '-no-reboot', '-display', 'none', '-serial', 'stdio', '-monitor', 'none',
  ...(network ? ['-bios',resolve(dirname(qemu),'share','bios-microvm.bin')] : []),
  ...(network ? ['-netdev',packetCarrier?'socket,id=oracle-net,udp=127.0.0.1:8090,localaddr=127.0.0.1:8091':'user,id=oracle-net','-device','virtio-net-device,bus=virtio-mmio-bus.0,netdev=oracle-net,csum=off,guest_csum=off,guest_tso4=off,guest_tso6=off,host_tso4=off,host_tso6=off'] : []),
];
if (process.platform === 'win32') args.unshift('-L', resolve(dirname(qemu), 'share'));
const child = spawn(qemu, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let tail = '';
let bytes = 0;
let readyMs;
let consoleMs;
let outcome;
let serialInput;
const stop = reason => {
  if (outcome !== undefined) return;
  outcome = reason;
  child.kill();
};
const timeoutMs = source || guestCheck ? 600_000 : fullSystem ? 120_000 : 45_000;
const timeout = setTimeout(() => stop(`boot/command timeout after ${timeoutMs / 1000} seconds`), timeoutMs);
const sendCommands = async () => {
  const fullCommands = [
    'test "$(readlink /proc/1/exe)" = /usr/bin/s6-svscan',
    'test -s /etc/apk/world', 'test -s /lib/apk/db/installed',
    'test -s /etc/passwd', 'test -s /etc/s6-rc/compiled/current/db',
    '/usr/libexec/system/ready api', '/usr/libexec/system/ready root',
    'console_pid=$(/usr/bin/s6-svstat -o pid /run/service/console)',
    'test "$(readlink /proc/$console_pid/exe)" = /bin/busybox',
    '/usr/bin/s6-rc -l /run/s6-rc -a list >/tmp/oracle-services',
    'grep -qx interactive-ready /tmp/oracle-services',
    'if grep -Eq "^(dhcpcd|chronyd|network-ready|time-synced)$" /tmp/oracle-services; then exit 1; fi',
    '/usr/bin/s6-rc -l /run/s6-rc diff',
    'printf "oracle-system-ready\\n"',
    'mkdir -p /tmp/oracle-development', 'cd /tmp/oracle-development',
    `printf '%s\\n' '#include <stdio.h>' 'int main(void) { puts("native-system-ok"); return 0; }' >hello.c`,
    'printf "all:\\n\\tcc hello.c -o hello\\n" >Makefile',
    'make -s -j4', 'test "$(./hello)" = native-system-ok',
    'git init -q', 'git add hello.c Makefile',
    'git -c user.name=Oracle -c user.email=oracle@example.invalid commit -qm initial',
    'test "$(git rev-list --count HEAD)" = 1',
    'openssl enc -aes-256-cbc -pbkdf2 -salt -pass pass:oracle-test-only -in hello.c -out hello.enc',
    'openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:oracle-test-only -in hello.enc -out hello.dec',
    'cmp hello.c hello.dec',
    'apk info musl >/tmp/oracle-apk-info', 'grep -q musl /tmp/oracle-apk-info',
    ...(networkTools ? [
      'ip link set lo up',
      'ip addr show lo >/tmp/oracle-address',
      'grep -q 127.0.0.1 /tmp/oracle-address',
      'ip addr add 192.0.2.9/32 dev lo',
      'ip addr show lo >/tmp/oracle-address-added',
      'grep -q 192.0.2.9 /tmp/oracle-address-added',
      'dhcpcd --version',
      'dhcpcd --help >/tmp/oracle-dhcp-help',
      'printf "oracle-network-tools\\n"',
    ] : []),
    ...(network ? [
      '/usr/bin/ip link set eth0 up',
      '/usr/bin/ip addr add 10.0.2.15/24 dev eth0',
      '/usr/bin/ip route add default via 10.0.2.2',
      'printf "nameserver 10.0.2.3\\n" >/etc/resolv.conf',
      `printf '%s\\n' '${readFileSync(new URL('./network-client.c',import.meta.url),'utf8').replaceAll("'","'\\''")}' >resolver.c`,
      'cc resolver.c -o resolver', './resolver',
      'curl --fail --connect-timeout 15 --max-time 30 -I https://example.com >/tmp/oracle-https',
      'grep -q "200" /tmp/oracle-https',
      'printf "oracle-native-https\\n"',
    ] : []),
    'cp /run/release/etc/hosts /tmp/oracle-lower-hosts',
    'printf "127.0.0.1 oracle-copy-up\\n" >>/etc/hosts',
    'grep -q oracle-copy-up /etc/hosts',
    'cmp /tmp/oracle-lower-hosts /run/release/etc/hosts',
    'test -f /run/cow/upper/etc/hosts',
    'test ! -e /run/cow/upper/usr',
    ...(guestCheck?[
      'mkdir -p /workspace',
      'mkdir -p /tmp/oracle-inputs',
      ...guestFiles.flatMap(({name,bytes})=>[
        ...bytes.toString('base64').match(/.{1,2048}/g)?.map((part,i)=>
          `printf '%s' '${part}' ${i?'>>':'>'}/tmp/oracle-inputs/${name}.b64`)??[],
        `base64 -d /tmp/oracle-inputs/${name}.b64 >/tmp/oracle-inputs/${name}`,
      ]),
      ...guestCheck.toString('base64').match(/.{1,2048}/g).map((part,i)=>
        `printf '%s' '${part}' ${i?'>>':'>'}/tmp/guest-check.b64`),
      'base64 -d /tmp/guest-check.b64 >/tmp/guest-check.sh',
      'sh /tmp/guest-check.sh',
      'printf "oracle-guest-check:pass\\n"',
    ]:[]),
    ...(source?[
      `printf '%s\\n' 'source,0x38000000,${sourceExtent}' >/sys/module/phram/parameters/phram`,
      'mkdir -p /tmp/native-source',
      // The frozen release GNU tar has a separately retained PAX parsing red.
      // Test source uses portable USTAR until that separate red is solved.
      'tar -xf /dev/mtd1 -C /tmp/native-source',
      'cd /tmp/native-source',
      'make -j2 -C compiler/support all',
      'make -j2 -C compiler/x86 all',
      'make -j2 -C compiler/optimized-x86 all',
      'make -j2 -C compiler/postlink-compiler all check',
      'make -j2 -C compiler/artifact all',
      'printf "oracle-c-selfhosted\\n"',
    ]:[]),
  ].join('\n');
  // An `(...) && success || failure` list suppresses errexit inside the
  // subshell. Execute an independent shell instead: any failed prerequisite
  // must stop the witness, not be hidden by a later successful command.
  const quotedFullCommands = `'${fullCommands.replaceAll("'", "'\\''")}'`;
  const commands = fullSystem
    ? `sh -eu -c ${quotedFullCommands} && printf "oracle-system-command: 42\\n" || printf "oracle-system-failure\\n"\n`
    : [
    'set -e', 'n=$((6 * 7))', 'test "$n" -eq 42',
    '/bin/busybox uname -sr',
    '/bin/busybox printf "oracle-boot-command: %s\\n" "$n"', '',
  ].join('\n');
  // A pipe write is not UART flow control. Wait for the shell prompt and pace
  // input below the emulated receiver's FIFO capacity, including on slow TCG.
  for (const byte of Buffer.from(commands)) {
    if (outcome !== undefined) return;
    await new Promise((resolve, reject) => {
      child.stdin.write(Buffer.from([byte]), error => error ? reject(error) : resolve());
    });
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const consume = chunk => {
  bytes += chunk.length;
  log.write(chunk);
  tail = (tail + chunk.toString()).slice(-262_144);
  if (bytes > 16 * 1024 * 1024) return stop('serial output exceeded the probe limit');
  if (tail.includes('Kernel panic - not syncing')) return stop('kernel panic');
  if (tail.includes('x86/fpu: Giving up, no FPU found')) return stop('fatal FPU initialization');
  // An oops already invalidates the boot gate. Do not spend the remaining
  // timeout printing nested faults from an unsuccessful diagnostic path.
  if (/BUG: (?:kernel NULL pointer dereference|unable to handle)|Oops: Oops:/.test(tail)) {
    return stop('kernel oops');
  }
  const readyMarker = fullSystem
    ? /(?:^|[\r\n])interactive-ready\r?\n/
    : /(?:^|[\r\n])oracle-boot-probe-ready\r?\n/;
  if (readyMs === undefined && readyMarker.test(tail)) {
    readyMs = performance.now() - started;
  }
  if (fullSystem && consoleMs === undefined && /(?:^|[\r\n])console-ready\r?\n/.test(tail)) {
    consoleMs = performance.now() - started;
  }
  if ((fullSystem || readyMs !== undefined) && serialInput === undefined && /(?:^|[\r\n])[^\r\n]*# $/.test(tail)) {
    serialInput = sendCommands().catch(error => stop(`serial input: ${error.message}`));
  }
  if (fullSystem && /(?:^|[\r\n])oracle-system-failure\r?\n/.test(tail)) {
    stop('installed root/service/development check failed');
  }
  const completeMarker = fullSystem
    ? /(?:^|[\r\n])oracle-system-command: 42\r?\n/
    : /(?:^|[\r\n])oracle-boot-command: 42\r?\n/;
  // UART input can interleave the asynchronous service banner with shell
  // echo. The command witness independently checks completed service state;
  // it is authoritative even when the standalone banner is not observable.
  // Keep its upper-bound timing distinct from console availability.
  if (completeMarker.test(tail)) {
    if (readyMs === undefined) readyMs = performance.now() - started;
    stop(null);
  }
};
child.stdout.on('data', consume);
child.stderr.on('data', consume);
child.stdin.on('error', error => stop(`serial input: ${error.message}`));
log.on('error', error => stop(`serial log: ${error.message}`));
child.on('error', error => stop(`QEMU launch: ${error.message}`));
await new Promise(resolve => child.once('close', (code, signal) => {
  if (outcome === undefined) outcome = `QEMU exited before shell commands completed (code=${code}, signal=${signal})`;
  resolve();
}));
clearTimeout(timeout);
await serialInput;
log.end();
await finished(log);
if (outcome !== null) {
  console.error(`native boot probe: red (${outcome ?? 'QEMU exited before shell commands completed'})`);
  console.error(tail.slice(-4096));
  process.exitCode = 1;
} else {
  const milestone = fullSystem
    ? 'installed root -> PID 1/services/offline -> C/make -j4/Git/AES/apk'
    : 'kernel -> init -> shell/exec/arithmetic';
  console.log(`native ${fullSystem ? 'system boot' : 'boot probe'}: green (${milestone}${source?' -> self-hosted C gates':''}, ready=${readyMs.toFixed(1)}ms, QEMU ${accelerator.toUpperCase()})`);
  if (consoleMs !== undefined) console.log(`console availability: ${consoleMs.toFixed(1)}ms; service/command completion is a separate gate`);
  console.log(`serial log: ${output}`);
}

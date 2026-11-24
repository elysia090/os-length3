// Manual loopback benchmark of the npm starter in stock, sandboxed Chrome.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {lstatSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {availableParallelism, cpus, release, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {parseArgs} from 'node:util';
import {chromium, type BrowserContext, type Page} from '@playwright/test';
import {linuxSandboxReport} from '../../../everyday/test/wayland/browser/stock-chrome.ts';
import {withStarterPreview} from './fixtures/starter-preview.ts';

const workloads = {
  shell: String.raw`test -t 0 && test "$(stty size)" = '24 80' && test "$PWD" = "$HOME" && test -w "$HOME" && test ! -e ~/ricebox-bench`,
  logs: String.raw`d=$HOME/ricebox-bench; mkdir -p "$d/logs" && awk -v dir="$d/logs" 'BEGIN { for(i=0;i<32768;i++) { file=sprintf("%s/%02d.log",dir,i%32); printf "%s %05d path=/example/report.txt request=%06d\n", (i%16==0?"ERROR":"INFO"), i, i >> file } }' && test "$(grep -h '^ERROR ' "$d"/logs/*.log | wc -l)" -eq 2048`,
  archive: String.raw`tar -czf "$d/logs.tgz" -C "$d" logs && mkdir "$d/unpack" && tar -xzf "$d/logs.tgz" -C "$d/unpack" && diff -r "$d/logs" "$d/unpack/logs"`,
  git: String.raw`mkdir "$d/repo" && git -C "$d/repo" -c init.defaultBranch=main init -q && printf 'one\n' > "$d/repo/file.txt" && git -C "$d/repo" add file.txt && git -C "$d/repo" -c user.name=Ricebox -c user.email=bench@example.invalid commit -qm first && printf 'two\n' >> "$d/repo/file.txt" && git -C "$d/repo" --no-pager diff --no-ext-diff | grep -qx '+two'`,
  make: String.raw`mkdir "$d/build" && cd "$d/build" && printf '#include <stdio.h>\nint main(void){puts("42");return 0;}\n' > main.c && printf 'all: app\napp: main.c\n\t$(CC) -O2 main.c -o app\n' > Makefile && make -s && test -s app && test -x app`,
};

// Playwright page requests omit dedicated Worker fetches. Observe completed
// HTTP bodies in the preview process, including worker pack ranges.
const httpProbe = `
  import {subscribe} from 'node:diagnostics_channel';
  import {openSync, writeSync} from 'node:fs';
  const fd = openSync(process.env.RICEBOX_BENCH_HTTP_LOG, 'wx');
  subscribe('http.server.response.created', ({request, response}) => {
    const writeHead = response.writeHead;
    response.writeHead = function (status, headers) {
      const length = headers?.['Content-Length'];
      if (request.method === 'GET' && (status === 200 || status === 206) && Number.isSafeInteger(length)) {
        response.once('finish', () => writeSync(fd, [Date.now(), request.url, length].join('\t') + '\\n'));
      }
      return Reflect.apply(writeHead, this, arguments);
    };
  });
`;

function rssKiB(pid: number, field = 'VmRSS'): number {
  try {
    const value = new RegExp('^' + field + ':\\s+(\\d+) kB$', 'm').exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
    return Number(value ?? 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function withPage(context: BrowserContext, url: string, httpLog: string, rendererRss: () => Promise<number>) {
  const page = await context.newPage();
  const idle = await rendererRss();
  const phases: {activity: string; at: number}[] = [];
  const mark = (activity: string) => phases.push({activity, at: Date.now()});
  const rendererPeaksKiB: Record<string, number> = {boot: idle};
  async function sample(activity = phases.at(-1)?.activity ?? 'boot') {
    const resident = await rendererRss();
    rendererPeaksKiB[activity] = Math.max(rendererPeaksKiB[activity] ?? 0, resident);
  }
  let sampling = true;
  const monitor = (async () => {
    while (sampling) {
      await delay(100);
      if (sampling) await sample();
    }
  })();
  const input = page.getByRole('textbox', {name: 'Guest terminal input'});
  async function run(name: string, script: string) {
    await input.focus();
    await page.keyboard.insertText(`${script}; rc=$?; printf '\\nRICEBOX_%s=%s\\n' ${name} "$rc"`);
    const start = performance.now();
    await input.press('Enter');
    const result = await page.waitForFunction(name => {
      const label = `RICEBOX_${name}=`;
      for (const row of document.querySelectorAll('#output .vt-row')) {
        const line = row.textContent?.trim();
        if (line?.startsWith(label)) return line.slice(label.length);
      }
      return false;
    }, name, {timeout: 90_000});
    const wallMs = performance.now() - start;
    const status = await result.jsonValue();
    await result.dispose();
    assert.equal(status, '0', `${name} failed (${status})`);
    return wallMs;
  }
  try {
    mark('boot');
    const navigation = performance.now();
    await page.goto(url, {waitUntil: 'commit'});
    await page.locator('#status[data-phase="attached"]').waitFor({timeout: 35_000});
    const attachedMs = performance.now() - navigation;
    await run('shell', workloads.shell);
    const firstCommandMs = performance.now() - navigation;
    await sample('boot');
    const wallMs: Record<string, number> = {};
    for (const [name, script] of Object.entries(workloads)) {
      if (name === 'shell') continue;
      mark(name);
      wallMs[name] = await run(name, script);
      await sample(name);
    }
    mark('exit');
    await input.focus();
    await page.keyboard.insertText('exit 0');
    const exiting = performance.now();
    await input.press('Enter');
    await page.locator('#status[data-phase="closed"]').waitFor({timeout: 15_000});
    const retireDeadline = performance.now() + 5_000;
    while (page.workers().length && performance.now() < retireDeadline) await delay(10);
    assert.equal(page.workers().length, 0, 'guest and asset-checker workers must be retired');
    const exitMs = performance.now() - exiting;
    sampling = false;
    await monitor;
    const bytes: Record<string, number> = {};
    const packBytes: Record<string, number> = {};
    for (const line of readFileSync(httpLog, 'utf8').trim().split('\n')) {
      const [time, path, size] = line.split('\t');
      const phase = phases.findLast(phase => phase.at <= Number(time));
      if (!phase || !path) continue;
      const {activity} = phase, length = Number(size);
      bytes[activity] = (bytes[activity] ?? 0) + length;
      if (new URL(path, url).pathname.endsWith('.pack')) packBytes[activity] = (packBytes[activity] ?? 0) + length;
    }
    assert.ok(bytes.boot > 0, 'preview and worker traffic must be visible');
    return {attachedMs, firstCommandMs, wallMs, exitMs, bytes, packBytes,
      rendererIdleKiB: idle, rendererPeaksKiB, rendererPeakKiB: Math.max(...Object.values(rendererPeaksKiB))};
  } catch (error) {
    throw new Error(await terminalLog(page), {cause: error});
  } finally {
    sampling = false;
    await monitor;
    await page.close();
  }
}

async function terminalLog(page: Page) {
  return (await page.locator('#status, #output .vt-row').allTextContents()).map(row => row.trimEnd()).filter(Boolean).join('\n');
}

const {positionals, values} = parseArgs({allowPositionals: true, options: {
  chrome: {type: 'string'}, runs: {type: 'string', default: '5'},
}});
const chrome = values.chrome, runs = Number(values.runs);
assert.ok(chrome && positionals.length === 1 && Number.isInteger(runs) && runs > 0,
  'Usage: starter-benchmark.ts INSTALLED_WORKSPACE --chrome CHROME [--runs N]');
const cwd = resolve(positionals[0]!);
assert.equal(process.platform, 'linux', 'Renderer RSS is read from Linux /proc');
assert.ok(!lstatSync(join(cwd, 'ricebox.json'), {throwIfNoEntry: false}), 'Benchmark the bundled defaults without a local declaration');
const install = join(cwd, 'node_modules/ricebox');
const {bin} = JSON.parse(readFileSync(join(install, 'package.json'), 'utf8')) as {bin: Record<string, string>};
const entry = join(install, bin['ricebox-stage-shell']);
const {version: ricebox, sha256: rootSha256} = JSON.parse(readFileSync(join(dirname(entry), 'default/prepared/webroot.json'), 'utf8'));
const host = {node: process.version, arch: process.arch, kernel: release(), cpu: cpus()[0]?.model, parallelism: availableParallelism()};
const version = execFileSync(chrome, ['--version'], {encoding: 'utf8', timeout: 5_000}).trim();
assert.match(version, /^Google Chrome /);
const work = mkdtempSync(join(tmpdir(), 'ricebox-benchmark-'));
const httpLog = join(work, 'http.log');
const env = {...process.env, RICEBOX_BENCH_HTTP_LOG: httpLog,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=data:text/javascript,${encodeURIComponent(httpProbe)}`};
const previewStarted = performance.now();
const report = await withStarterPreview(entry, cwd, async (url, pid) => {
  const preview = {readyMs: performance.now() - previewStarted, peakKiB: rssKiB(pid, 'VmHWM')};
  let sandbox: ReturnType<typeof linuxSandboxReport> | undefined;
  const pairs: {cold: Awaited<ReturnType<typeof withPage>>; revisit: Awaited<ReturnType<typeof withPage>>}[] = [];
  for (let i = 0; i < runs; i++) {
    const browser = await chromium.launch({executablePath: chrome, headless: true, chromiumSandbox: true});
    try {
      if (!sandbox) {
        const page = await browser.newPage();
        await page.goto('chrome://sandbox/');
        await page.getByText('Seccomp-BPF sandbox', {exact: true}).waitFor({timeout: 5_000});
        sandbox = linuxSandboxReport(await page.locator('#sandbox-status tr').evaluateAll(rows => rows.map(row => {
          const {cells} = row as HTMLTableRowElement;
          return [cells[0]?.textContent?.trim() ?? '', cells[1]?.textContent?.trim() ?? ''] as const;
        })));
        await page.close();
      }
      const cdp = await browser.newBrowserCDPSession();
      const rendererRss = async () => {
        const {processInfo} = await cdp.send('SystemInfo.getProcessInfo');
        return processInfo.filter(process => process.type === 'renderer')
          .reduce((sum, process) => sum + rssKiB(process.id), 0);
      };
      const context = await browser.newContext();
      // The revisit retains the origin's Cache Storage and starts a new guest.
      const cold = await withPage(context, url, httpLog, rendererRss);
      assert.ok(Object.values(cold.packBytes).some(bytes => bytes > 0), 'the cold workload must read HTTP pack ranges');
      const revisit = await withPage(context, url, httpLog, rendererRss);
      pairs.push({cold, revisit});
      console.error(`Ricebox benchmark ${i + 1}/${runs} complete`);
    } finally { await browser.close(); }
  }
  return {version, sandbox, host, ricebox, rootSha256, preview, pairs};
}, env).finally(() => rmSync(work, {recursive: true, force: true}));
console.log(JSON.stringify(report, null, 2));

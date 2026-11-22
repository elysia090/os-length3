// Opt-in acceptance from a real, trusted release. This test never builds a guest,
// downloads a browser, serves on a public interface, or disables Chrome sandboxing.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {extname, join, resolve, sep} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {linuxSandboxReport} from '../../../everyday/test/wayland/browser/stock-chrome.ts';

const build = fileURLToPath(new URL('../../build/npm.ts', import.meta.url));
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
};

async function serve(directory: string) {
  const server = createServer((request, response) => {
    try {
      const path = resolve(directory, '.' + new URL(request.url ?? '/', 'http://localhost').pathname);
      if (request.method !== 'GET' || !path.startsWith(directory + sep) || !lstatSync(path).isFile()) {
        response.writeHead(404).end(); return;
      }
      const bytes = readFileSync(path), type = types[extname(path)] ?? 'application/octet-stream';
      const range = request.headers.range;
      if (range && path.endsWith('.pack')) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        const start = Number(match?.[1]), end = Number(match?.[2]);
        if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= bytes.length) {
          response.writeHead(416, {'Content-Range': `bytes */${bytes.length}`}).end(); return;
        }
        response.writeHead(206, {'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`})
          .end(bytes.subarray(start, end + 1));
      } else response.writeHead(200, {'Content-Type': type}).end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done, reject) => server.listen(0, '127.0.0.1', done).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {origin: `http://127.0.0.1:${address.port}`, close: () => server.close()};
}

test('a clean staged shell runs two real guest commands in one small nested iframe', {timeout: 120_000}, async () => {
  const prepared = process.env.RICEBOX_STARTER_PREPARED_ROOT;
  const webPin = process.env.RICEBOX_STARTER_WEBROOT_PIN;
  const mukPin = process.env.RICEBOX_STARTER_MUK_PIN;
  const executablePath = process.env.RICEBOX_STARTER_CHROME;
  assert.ok(prepared && webPin && mukPin && executablePath, 'Supply the trusted prepared root, both descriptor pins and stock Chrome');
  const version = execFileSync(executablePath, ['--version'], {encoding: 'utf8', timeout: 5000}).trim();
  assert.match(version, /^Google Chrome /, 'set RICEBOX_STARTER_CHROME to the installed stock Chrome');
  const {chromium, expect} = await import('@playwright/test');
  const work = mkdtempSync(join(tmpdir(), 'ricebox-starter-browser-'));
  try {
    const pkg = join(work, 'package'), consumer = join(work, 'consumer'), host = join(work, 'host');
    const npm = (cwd: string, args: string[]) => execFileSync('npm', args, {cwd, encoding: 'utf8', timeout: 30_000,
      env: {...process.env, npm_config_cache: join(work, 'npm-cache')}});
    execFileSync(process.execPath, [build, pkg], {timeout: 30_000});
    const [tarball] = JSON.parse(npm(pkg, ['pack', '--offline', '--ignore-scripts', '--pack-destination', work, '--json'])) as {filename: string}[];
    mkdirSync(consumer); mkdirSync(join(host, 'docs', 'example'), {recursive: true});
    writeFileSync(join(consumer, 'package.json'), '{"private":true}\n');
    npm(consumer, ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(work, tarball.filename)]);
    npm(consumer, ['exec', '--offline', '--', 'ricebox-stage-shell', resolve(prepared),
      join(host, 'docs', 'example', 'linux'), webPin, mukPin]);
    writeFileSync(join(host, 'docs', 'example', 'index.html'), `<!doctype html><title>Host example</title>
      <link rel="icon" href="data:,">
      <label>Host field <input></label>
      <iframe src="./linux/index.html" title="Ricebox Linux shell" width="640" height="400"></iframe>`);
    const http = await serve(host);
    try {
      const browser = await chromium.launch({executablePath, headless: true, chromiumSandbox: true, timeout: 30_000,
        ignoreDefaultArgs: ['--unsafely-disable-devtools-self-xss-warnings', '--enable-unsafe-swiftshader']});
      try {
        const config = await browser.newPage();
        await config.goto('chrome://sandbox/', {timeout: 8000});
        await config.getByText('Seccomp-BPF sandbox', {exact: true}).waitFor({timeout: 4000});
        const rows = await config.locator('#sandbox-status tr').evaluateAll(elements => elements.map(element => {
          const cells = (element as HTMLTableRowElement).cells;
          return [cells[0]?.textContent?.trim() ?? '', cells[1]?.textContent?.trim() ?? ''] as const;
        }));
        console.log(version, linuxSandboxReport(rows));
        await config.close();
        const page = await browser.newPage();
        const urls: string[] = [];
        page.on('request', request => urls.push(request.url()));
        const url = http.origin + '/docs/example/index.html';
        await page.goto(url, {waitUntil: 'domcontentloaded'});
        const hostField = page.getByRole('textbox', {name: 'Host field'});
        await hostField.focus();
        const shell = page.frameLocator('iframe[title="Ricebox Linux shell"]');
        const status = shell.getByRole('status'), input = shell.getByRole('textbox', {name: 'Shell command'});
        const output = shell.getByLabel('Guest shell output');
        await expect(status).toHaveText('Guest shell is ready for a command.', {timeout: 30_000});
        await expect(hostField).toBeFocused();
        await expect(output).toContainText('ricebox$ ');
        await input.fill("nonce=23; i=0; while [ $i -lt 50 ]; do printf '%090d\\n' \"$i\"; i=$((i+1)); done; printf 'first=%s pid=%s\\n' \"$((nonce*3))\" \"$$\"");
        await input.press('Enter');
        await expect(output).toContainText(/(?:^|\n)first=69 pid=[1-9]\d*/);
        await expect(status).toHaveText('Guest shell is ready for a command.');
        const pid = (await output.textContent() ?? '').match(/(?:^|\n)first=69 pid=([1-9]\d*)/)?.[1];
        assert.ok(pid);
        await expect(input).toBeFocused();
        assert.equal(await output.evaluate(node => node.scrollHeight > node.clientHeight), true);
        assert.equal(await input.evaluate(node => node.getBoundingClientRect().bottom <= innerHeight), true);
        await input.fill("printf 'second=%s pid=%s\\n' \"$((nonce*4+2))\" \"$$\"");
        await input.press('Enter');
        await expect(output).toContainText(new RegExp(`(?:^|\\n)second=94 pid=${pid}(?:\\r?\\n|$)`));
        await expect(input).toBeFocused();
        assert.equal(page.url(), url);
        assert.equal(page.context().pages().length, 1);
        assert.ok(urls.every(value => value.startsWith(http.origin + '/docs/example/')), urls.join('\n'));
        await shell.getByRole('button', {name: 'End shell'}).click();
        await expect(status).toHaveText('Guest shell ended.');
        await expect(shell.getByRole('button', {name: 'Start a new shell'})).toBeEnabled();
      } finally { await browser.close(); }
    } finally { http.close(); }
  } finally { rmSync(work, {recursive: true, force: true}); }
});

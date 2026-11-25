import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, type Page} from '@playwright/test';
import {createServer} from 'vite';
import {releaseIndexAsset} from '../../../../../../distribution/format/manifest.ts';
import {linuxSandboxReport} from '../../../browser/stock-chrome.ts';
import {checkPointerCommits} from './pointer-proof.ts';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const [inputs, listener, indexSha256, mode, ...extra] = process.argv.slice(2);
if (!inputs || !listener || !/^[a-f0-9]{64}$/.test(indexSha256 ?? '') || extra.length ||
    (mode !== undefined && mode !== '--prepared' && mode !== '--pointer' && mode !== '--pointer-prepared-diagnostics'))
  throw new Error('usage: check.ts FIXTURE_INPUTS QUICKSHELL_LISTENER EXPECTED_INDEX_SHA256 [--prepared | --pointer | --pointer-prepared-diagnostics]');
const preparedDiagnostics = mode === '--pointer-prepared-diagnostics';
const prepared = mode === '--prepared' || preparedDiagnostics, pointer = mode === '--pointer' || preparedDiagnostics;
const executablePath = process.env.EVERYDAY_CHROME_BIN;
if (!executablePath) throw new Error('Set EVERYDAY_CHROME_BIN to the installed Chrome executable');
const publicDir = resolve(inputs), elf = readFileSync(listener), about = readFileSync(join(publicDir, 'web/webroot.json'));
const asset = releaseIndexAsset(JSON.parse(about.toString('utf8')));
assert.equal(asset.sha256, indexSha256);
const indexName = 'web/' + asset.path;
const pins = Object.fromEntries(['sods.wasm', 'muk', 'utc', 'guest-sources.json', 'web/webroot.json', indexName,
  ...(prepared ? ['prepared/index.json'] : []),
].map(path => [path, sha256(readFileSync(join(publicDir, path)))]));
assert.equal(pins[indexName], indexSha256);
pins.listener = sha256(elf);
const pointerQml = pointer ? readFileSync(new URL('../pointer.qml', import.meta.url)) : undefined;
if (pointerQml) pins['pointer.qml'] = sha256(pointerQml);

async function frame(page: Page, sequence: number, width: number, height: number) {
  await page.waitForFunction(n => document.querySelector('canvas')?.dataset.sequence === String(n) ||
    document.querySelector<HTMLElement>('#status')?.dataset.phase === 'error', sequence, {timeout: 35_000});
  const status = page.getByRole('status');
  assert.equal(await status.getAttribute('data-phase'), 'frame', await status.innerText());
  const canvas = page.locator('canvas');
  const rgba = await canvas.evaluate(element => {
    const canvas = element as HTMLCanvasElement, {width, height} = canvas;
    return {width, height, bytes: Array.from(canvas.getContext('2d')!.getImageData(0, 0, width, height).data)};
  });
  assert.deepEqual([rgba.width, rgba.height], [width, height]);
  const tint = pointer && sequence === 2 ? [64, 255, 128, 128] : [255, 128, 64, 128];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4;
    assert.deepEqual(rgba.bytes.slice(at, at + 4), pointer || (x >= 10 && x < 18 && y >= 8 && y < 14) ? tint : [0, 0, 0, 0],
      `canvas pixel ${x},${y} in frame ${sequence}`);
  }
  const path = sequence === 1 ? process.env.EVERYDAY_QUICKSHELL_SCREENSHOT : undefined;
  const screenshot = await canvas.screenshot({path, scale: 'css'});
  const composed = await page.evaluate(async png => {
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], {type: 'image/png'}));
    try {
      const sampling = document.createElement('canvas');
      sampling.width = image.width;
      sampling.height = image.height;
      const context = sampling.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return [context.getImageData(4, 4, 1, 1), context.getImageData(12 * 8 + 4, 10 * 8 + 4, 1, 1)]
        .map(pixel => Array.from(pixel.data));
    } finally { image.close(); }
  }, screenshot.toString('base64'));
  const painted = pointer && sequence === 2 ? [48, 160, 112, 255] : [144, 96, 80, 255];
  assert.deepEqual(composed, [pointer ? painted : [32, 64, 96, 255], painted]);
  console.log('CHROME_QUICKSHELL_FRAME', {sequence, width, height, rgba: sha256(Uint8Array.from(rgba.bytes)), composed});
}

const server = await createServer({configFile: false, publicDir, root: fileURLToPath(new URL('.', import.meta.url)),
  server: {host: '127.0.0.1', port: 0, cors: false, hmr: false,
    fs: {allow: [fileURLToPath(new URL('../../../../../../../', import.meta.url))]}},
  plugins: [{name: 'quickshell-test-inputs', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url === '/pins.json') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(pins));
      } else if (request.url === '/listener') {
        response.setHeader('Content-Type', 'application/octet-stream');
        response.end(elf);
      } else if (pointerQml && request.url === '/pointer.qml') {
        response.setHeader('Content-Type', 'application/octet-stream');
        response.end(pointerQml);
      } else next();
    });
  }}],
});
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({headless: true, chromiumSandbox: true, executablePath, timeout: 30_000});
  try {
    const sandbox = await browser.newPage();
    await sandbox.goto('chrome://sandbox/');
    await sandbox.getByText('Seccomp-BPF sandbox', {exact: true}).waitFor();
    const report = await sandbox.locator('#sandbox-status tr').evaluateAll(rows => rows.map(row => {
      const cells = (row as HTMLTableRowElement).cells;
      return [cells[0]?.textContent?.trim() ?? '', cells[1]?.textContent?.trim() ?? ''] as const;
    }));
    console.log('CHROME_QUICKSHELL_SANDBOX', browser.version(), linuxSandboxReport(report));
    await sandbox.close();
    const context = await browser.newContext({serviceWorkers: 'block'});
    const page = await context.newPage();
    await context.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
    let printedDiagnostics = false;
    try {
      await page.goto(pointer ? url + '/?pointer=1' + (preparedDiagnostics ? '&prepared-diagnostics=1' : '') : url);
      await frame(page, 1, 32, 24);
      if (pointer) {
        const canvas = page.locator('canvas'), box = await canvas.boundingBox(), status = page.getByRole('status');
        assert.ok(box);
        await page.mouse.click(box.x + box.width + 2, box.y + box.height / 2);
        assert.equal(await status.getAttribute('data-pointer-contacts'), null, 'Outside click reached guest input');
        assert.equal(await canvas.getAttribute('data-sequence'), '1', 'Panel changed before the target click');
        // The browser delivers this contact through Everyday, not directly to the Worker.
        await page.mouse.click(box.x + 12.5 * box.width / 32, box.y + 10.5 * box.height / 24);
        assert.equal(await status.getAttribute('data-pointer-contacts'), '1', 'Expected one real canvas contact');
        await frame(page, 2, 32, 24); // Same geometry: only QML input changes the pixels.
        if (preparedDiagnostics) {
          const json = await page.locator('#receipt').getAttribute('data-prepared-diagnostics');
          assert.ok(json, 'Missing first-click prepared-code receipt');
          const report = JSON.parse(json);
          assert.equal(report.indexSha256, indexSha256);
          assert.deepEqual([report.end, report.fromSequence, report.toSequence], ['raster', 1, 2]);
          console.log('CHROME_QUICKSHELL_PREPARED_DIAGNOSTICS', JSON.stringify(report));
          printedDiagnostics = true;
        }
      } else {
        await page.getByRole('button', {name: 'Resize guest'}).click();
        await frame(page, 2, 47, 19);
      }
      await page.getByRole('button', {name: 'Close guest'}).click();
      await page.waitForFunction(() => ['closed', 'error'].includes(document.querySelector<HTMLElement>('#status')?.dataset.phase ?? ''),
        undefined, {timeout: 12_000});
      const status = page.getByRole('status'), receipt = await page.locator('#receipt').innerText();
      assert.equal(await status.getAttribute('data-phase'), 'closed', await status.innerText());
      assert.equal(await page.locator('canvas').getAttribute('data-sequence'), '2');
      assert.equal(receipt.match(/WAYLAND_ALPHA format=argb8888/g)?.length, 2);
      if (pointer) checkPointerCommits(receipt);
      else assert.match(receipt, /WAYLAND_COMMIT seq=1 size=32x24[\s\S]*WAYLAND_COMMIT seq=2 size=47x19[\s\S]*WAYLAND_LAYER_CLIENT_DESTROY/);
      assert.match(receipt, /Loading backend software/);
      assert.match(receipt, /Configuration Loaded/);
      const preparedReads = Number(await status.getAttribute('data-prepared-reads'));
      assert.ok(preparedDiagnostics ? Number.isSafeInteger(preparedReads) && preparedReads >= 0 :
        prepared ? preparedReads > 0 : preparedReads === 0);
      console.log('CHROME_QUICKSHELL_RETIRED', {mode: mode?.slice(2) ?? 'on-demand', preparedReads});
    } catch (error) {
      const receipt = page.locator('#receipt');
      if (preparedDiagnostics && !printedDiagnostics) {
        const partial = await receipt.getAttribute('data-prepared-diagnostics', {timeout: 1000}).catch(() => null);
        if (partial) console.error('CHROME_QUICKSHELL_PREPARED_DIAGNOSTICS_INCOMPLETE', partial);
      }
      console.error(await receipt.textContent().catch(() => ''));
      throw error;
    } finally { await context.close(); }
  } finally { await browser.close(); }
} finally { await server.close(); }

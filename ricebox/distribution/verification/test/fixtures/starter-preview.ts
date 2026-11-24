import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';

export async function withStarterPreview<T>(entry: string, cwd: string, use: (url: string, pid: number) => Promise<T>, env = process.env) {
  const child = spawn(process.execPath, ['--no-experimental-strip-types', entry, '--preview'],
    {cwd, env, stdio: ['ignore', 'pipe', 'inherit']});
  const lines = createInterface({input: child.stdout});
  const stopped = once(child, 'exit');
  try {
    const [announcement] = await Promise.race([once(lines, 'line', {signal: AbortSignal.timeout(60_000)}),
      stopped.then(([code]) => assert.fail(`Preview exited before listening (${code})`))]);
    const url = /^Ricebox preview: (http:\/\/127\.0\.0\.1:\d+\/)$/u.exec(announcement)?.[1];
    assert.ok(url, announcement);
    assert.ok(child.pid);
    return await use(url, child.pid);
  } finally {
    child.kill('SIGTERM');
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try { assert.deepEqual(await stopped, [0, null]); }
    finally { clearTimeout(watchdog); lines.close(); }
  }
}

// Test-only evidence recorder. Requires an already authorized native session;
// it neither starts clients nor proves visual/input compatibility.
import {spawnSync} from 'node:child_process';
import {lstatSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';

type SocketStat = (path: string) => {isSocket(): boolean; isSymbolicLink(): boolean};
const usage = 'usage: native-preflight.ts ABS_RUNTIME_DIR SOCKET_NAME ABS_FOOT ABS_WAYBAR ABS_WAYLAND_INFO';

// Only the socket stat is injectable for offline fixtures that cannot bind a
// socket. The CLI always uses lstat; no environment flag bypasses this gate.
export function preflight(args: readonly string[], socketStat: SocketStat = lstatSync) {
  const [runtime, display, foot, waybar, registry] = args;
  const absolute = (s: string | undefined): s is string => !!s && !s.includes('\0') && isAbsolute(s);
  if (args.length !== 5 || !absolute(runtime) || !absolute(foot) || !absolute(waybar) || !absolute(registry) ||
      !display || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(display)) throw new Error(usage);
  const dir = lstatSync(runtime);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('runtime selection is not a direct directory');
  const socket = join(runtime, display), stat = socketStat(socket);
  if (!stat.isSocket() || stat.isSymbolicLink()) throw new Error('display selection is not a direct socket');
  const env = {...process.env};
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'WAYLAND_SOCKET', 'XDG_RUNTIME_DIR']) delete env[key];
  const inspect = (label: string, binary: string, argv: string[], registryOnly = false) => {
    const result = spawnSync(binary, argv, {
      env: registryOnly ? {...env, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: display} : env,
      encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.signal || result.status !== 0) {
      const said = result.stderr?.trim().slice(-240);
      const why = result.error?.message ?? result.signal ?? `exit ${result.status}`;
      throw new Error(`${label} failed (${why})${said ? `: ${JSON.stringify(said)}` : ''}; no evidence report produced`);
    }
    if (!result.stdout.trim() && (registryOnly || !result.stderr.trim())) throw new Error(`${label} returned no evidence`);
    return {binary, args: argv, stdout: result.stdout, stderr: result.stderr};
  };
  const clients = {foot: inspect('foot version', foot, ['--version']), waybar: inspect('waybar version', waybar, ['--version'])};
  const interfaces = inspect('Wayland registry', registry, [], true);
  return {
    kind: 'everyday-native-preflight', visualAcceptance: 'not-tested', protocolCompatibility: 'not-validated',
    selection: {runtime, display, socket}, clients, registry: interfaces,
  };
}

if (import.meta.main) {
  try { console.log(JSON.stringify(preflight(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

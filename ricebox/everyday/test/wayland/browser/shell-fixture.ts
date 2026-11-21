/** An ordinary interactive BusyBox shell in a second, independent root Worker. */
export function shellStart(translator: Uint8Array, muk: Uint8Array, busybox: Uint8Array) {
  const config = JSON.stringify({
    ociVersion: '1.0.2',
    process: {args: ['/bin/busybox', 'sh', '-i'], cwd: '/', noNewPrivileges: true,
      env: ['PATH=/bin', 'HOME=/', 'TERM=dumb', 'PS1=everyday$ ']},
    root: {path: '/', readonly: true},
    linux: {
      namespaces: ['pid', 'network', 'ipc', 'uts', 'mount', 'user'].map(type => ({type})),
      uidMappings: [{containerID: 0, hostID: 0, size: 1}],
      gidMappings: [{containerID: 0, hostID: 0, size: 1}],
    },
  });
  return {
    type: 'start', translator, muk, cwd: '/', screen: true,
    box: {config, words: ['run', '--lend', '/', '--ids', '0-0', '-b', '/run/box', 'shell']},
    files: [{path: '/bin/busybox', bytes: busybox, mode: 0o755}],
  };
}

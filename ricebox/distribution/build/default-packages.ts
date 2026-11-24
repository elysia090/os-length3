/** Issue #80's userland, using the existing Ricebox recipes. */
export const defaultPackages = Object.freeze([
  // Shell, files, text and terminal.
  'bash', 'busybox', 'coreutils', 'grep', 'musl-utils', 'ncurses', 'patch', 'system-config', 'util-linux',
  // Search, archives, data, Git, TLS, editors and the shell's interactive tools.
  'bzip2', 'ca-certificates', 'curl', 'delta', 'direnv', 'fd', 'file', 'fzf', 'git', 'git-lfs', 'gzip',
  'jq', 'less', 'nano', 'openssl', 'ripgrep', 'sqlite', 'tar', 'tzdata', 'wget', 'xz', 'you', 'yq', 'zip', 'zstd',
  // Installed package inventory, C build tools, and network utilities.
  'apk-tools', 'binutils', 'fortify-headers', 'gcc', 'iproute2', 'linux-headers', 'make', 'musl',
  'openssh-client', 'pkgconf',
] as const);

/* The numeric x86-64 Linux ABI used by this OCI profile. No calls or host objects. */
#pragma once
enum {
  SYS_rt_sigprocmask = 14, SYS_ioctl = 16, SYS_getpid = 39, SYS_socket = 41, SYS_connect = 42, SYS_sendmsg = 46, SYS_fchown = 93,
  SYS_setsid = 112, SYS_execve = 59, SYS_wait4 = 61, SYS_kill = 62, SYS_chdir = 80,
  SYS_symlink = 88, SYS_umask = 95, SYS_geteuid = 107, SYS_setgroups = 116, SYS_setresuid = 117,
  SYS_setresgid = 119, SYS_capset = 126, SYS_rt_sigtimedwait = 128, SYS_mknod = 133, SYS_statfs = 137,
  SYS_pivot_root = 155, SYS_prctl = 157, SYS_mount = 165, SYS_umount2 = 166, SYS_sethostname = 170,
  SYS_setdomainname = 171, SYS_prlimit64 = 302, SYS_setns = 308, SYS_open_tree = 428, SYS_move_mount = 429,
  SYS_seccomp = 317, SYS_close_range = 436, SYS_mount_setattr = 442, SYS_fchdir = 81, SYS_fstatfs = 138,
  SYS_unshare = 272, SYS_clone3 = 435, SYS_openat2 = 437, SYS_fcntl = 72,
};
enum { EPERM = 1, EACCES = 13, ENOTDIR = 20, EAFNOSUPPORT = 97 };
enum { O_NOCTTY = 0400, O_DIRECTORY = 0200000, O_PATH = 010000000 };
enum {
  MS_RDONLY = 1, MS_NOSUID = 2, MS_NODEV = 4, MS_NOEXEC = 8, MS_SYNCHRONOUS = 16, MS_REMOUNT = 32, MS_DIRSYNC = 128,
  MS_NOSYMFOLLOW = 256, MS_NOATIME = 1024, MS_NODIRATIME = 2048, MS_BIND = 4096, MS_REC = 16384,
  MS_UNBINDABLE = 1 << 17, MS_PRIVATE = 1 << 18, MS_SLAVE = 1 << 19, MS_SHARED = 1 << 20, MS_RELATIME = 1 << 21,
  MS_STRICTATIME = 1 << 24, MS_LAZYTIME = 1 << 25,
};
#define MS_SPREAD (MS_UNBINDABLE | MS_PRIVATE | MS_SLAVE | MS_SHARED)
enum { MNT_DETACH = 2 };
enum {
  CLONE_NEWNS = 0x00020000, CLONE_NEWCGROUP = 0x02000000, CLONE_NEWUTS = 0x04000000, CLONE_NEWIPC = 0x08000000,
  CLONE_NEWUSER = 0x10000000, CLONE_NEWPID = 0x20000000, CLONE_NEWNET = 0x40000000,
};
enum { SIGKILL = 9, SIGCHLD = 17 };

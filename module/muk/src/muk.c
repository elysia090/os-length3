/*
 * muk: the x86-64 Linux OCI bundle runner. `muk run` starts a bundle's process as the OCI runtime says (its config.json: the
 * namespaces it is in, its root and what is mounted there, who it is and what it may do) and waits for it. No KVM
 * and no Firecracker under it: the host's kernel is the machine, and a box is its namespaces. Private parser and filter headers on lib, with
 * no C library; what it does is counted in the README beside it, and checked beside runc on the same bundles
 * (test/bundle/muk.sh).
 *
 *   muk run [-b BUNDLE] [--console-socket PATH] [--lend PATH]... [--ids FIRST-LAST] [--cgroup DIR] [ID]
 *                                 the bundle's process, started and waited for; muk ends as it ends
 *
 * Where muk ends and the Prompt begins (../../prompt). A run is a box's whole life here: muk names no box, keeps
 * none beyond its run, lists none. A terminal is a device of the box, so muk makes it where only it can (in the
 * box's own /dev/pts, config.json asking: process.terminal) and makes it the box's; its other end it gives away,
 * whole, to the one who asked (one descriptor sent over --console-socket) and keeps nothing of: what is typed and
 * shown there, its size as it changes, who is at it and whether anyone is, are the Prompt's.
 *
 * The floor: what every box has, whatever config.json says (it may ask for more, never for less): and config.json
 * is someone else's, who may mean harm, on a machine many share. So config.json asks and the one who runs muk
 * lends: nothing of the host's is a box's for its asking. A path of the host's (the root, what a bind takes, a
 * namespace joined) is the bundle's own or one lent (--lend), opened once and by the kernel's rule that nothing
 * leads out of it; its mount, pid, ipc, uts and network namespaces are its own or one lent, the first four never
 * the host's (a network of its own has its loopback up and nothing else), and it has a cgroup namespace; each of the host's users it can be is one lent (--ids); it gains no
 * privilege by what it runs (no_new_privs); it has the capabilities config.json names and, in no user namespace,
 * none over the host itself; a device is what muk made in a /dev that is the box's own or one lent by its own
 * name, every other mount being nodev (the root, a bind, a tmpfs), and it makes none (CAP_MKNOD is a user
 * namespace's alone); what is mounted is what was lent or a kind that is a box's own (proc, sysfs, tmpfs, devpts,
 * mqueue, its cgroups); where it can be the host's root, what of /proc and /sys tells of the host or changes it
 * is hidden or read-only (FLOOR_PROC, FLOOR_SYS), and /sys and its cgroups are read and not written; there is
 * what no box asks the kernel at all (FILTER: the kernel itself, another process's memory, the mounts, a namespace
 * inside its own, the parts of the kernel where escapes are found, and every call the filter was not written
 * against); and what it may use of the machine is its cgroup's, the one lent (--cgroup) or muk's own, which it is
 * never out of. test/bundle/hostile.sh is a config.json written against each of these.
 *
 * config.json is read once, where it is: a string is used in its place in the text, a NUL put over its closing
 * quote, so nothing is copied. The box is made by one clone into its namespaces; in it, the root is bound on itself
 * and made the root (pivot_root), the host's root taken away, and only then is anything mounted in it: a
 * destination is a path in the box's own root with nothing of the host's above it, so a link the root holds leads
 * nowhere outside it, however far up it says to go. What a bind takes from the host is opened before the root
 * changes (openat2, then open_tree of what was opened), where the host's paths still mean the host's.
 */
#define UNIT "muk"
#define ARENA (4 << 20)
#define ARENA_SERIAL 1 /* One thread; clone makes independent processes, never CLONE_VM. */
#include "../../lib/arena.h"

#include "linux-abi.h"

__attribute__((noreturn, cold)) static inline void fail(const char *what, const char *about) {
  __attribute__((uninitialized)) u8 m[600];
  u64 n = 0;
  const char *parts[3] = {UNIT ": ", what, about};
  for (int i = 0; i < 3; i++)
    for (const char *s = parts[i]; s && *s && n < sizeof m - 2; s++) m[n++] = (u8)*s;
  m[n++] = '\n';
  sys3(SYS_write, 2, (i64)m, (i64)n);
  leave(1);
}

/* ---- How it fails: what, about what, and the kernel's number for why. */

static u8 *dec(u8 *p, u64 v) {
  u8 t[20];
  u32 n = 0;
  do t[n++] = (u8)('0' + v % 10); while (v /= 10);
  while (n) *p++ = t[--n];
  return p;
}
__attribute__((noreturn, cold)) static void die(const char *what, const char *about, i64 r) {
  u8 m[400];
  u64 n = 0;
  for (const char *s = about; s && *s && n < sizeof m - 40; s++) m[n++] = (u8)*s;
  if (r < 0) {
    static const char e[] = " (errno ";
    for (const char *s = e; *s; s++) m[n++] = (u8)*s;
    n = (u64)(dec(m + n, (u64)-r) - m);
    m[n++] = ')';
  }
  m[n] = 0;
  fail(what, (const char *)m);
}
static i64 ok(i64 r, const char *what, const char *about) {
  if (r < 0) die(what, about, r);
  return r;
}

#include "bundle.h"

/* ---- What is lent: the words of the one who runs muk. config.json asks; nothing of the host's is a box's by its
 * asking. A path of the host's (what a bind takes, the root, a namespace joined) is the bundle's own or one lent
 * (--lend); a user of the host's is one lent (--ids; to one who is not root, the kernel lends that one alone);
 * what it may use of the machine is its cgroup's (--cgroup). */
static struct { const char *path; u32 n; int fd; } lent[16]; /* n: its length, with no slash at its end */
static u32 nlent;
static u64 ids_first = 1, ids_last; /* the host's users and groups a box may be: none, until said */
static const char *cgroup;

/* A path of the host's that config.json names, opened. One not from the root is the bundle's, and leads nowhere
 * outside it, by a link or by `..` (the kernel sees to it: RESOLVE_BENEATH). One from the root is what was lent by
 * that very name (`named`: what the box's first process opened of it while it was still the one who lent it,
 * `inside`, which is not the caller's to close; or, to be read, opened again as the lender names it), or lies
 * under what was lent and leads nowhere outside that. Anything else is the host's, and no box's to name. */
static i64 taken(const char *path, u64 how, int *named) {
  struct { u64 flags, mode, resolve; } beneath = {how | O_CLOEXEC, 0, 0x08 /* RESOLVE_BENEATH */};
  *named = 0;
  if (path[0] != '/') return sys4(SYS_openat2, AT_FDCWD, (i64)path, (i64)&beneath, sizeof beneath);
  for (u32 i = 0; i < nlent; i++) {
    u32 n = lent[i].n, k = 0;
    while (k < n && path[k] == lent[i].path[k]) k++;
    if (k < n || (path[n] && path[n] != '/')) continue;
    const char *rest = path + n;
    while (*rest == '/') rest++;
    if (!*rest) return *named = 1, how == O_PATH ? lent[i].fd : sys3(SYS_open, (i64)lent[i].path, (i64)(how | O_CLOEXEC), 0);
    /* (before there is a box, for a namespace under what was lent: opened for this, and closed) */
    i64 under = lent[i].fd >= 0 ? lent[i].fd : ok(sys3(SYS_open, (i64)lent[i].path, O_PATH | O_DIRECTORY | O_CLOEXEC, 0), "--lend: ", lent[i].path);
    i64 r = sys4(SYS_openat2, under, (i64)rest, (i64)&beneath, sizeof beneath);
    if (under != lent[i].fd) sys1(SYS_close, under);
    return r;
  }
  fail("config.json: it names what is the host's and was not lent (--lend): ", path);
}

/* ---- The box. */

/* The directories on the way to `path` (and `path` itself, with `last`), made where there are none. */
static void make_dirs(char *path, int last) {
  if (last) { /* (itself first: the ones before it are mostly there) */
    i64 r = sys2(SYS_mkdir, (i64)path, 0755);
    if (r >= 0 || r == -EEXIST) return;
    if (r != -ENOENT) die("mkdir ", path, r);
  }
  for (char *s = path + 1;; s++) {
    if (*s && *s != '/') continue;
    if (!*s && !last) return;
    char end = *s;
    *s = 0;
    i64 r = sys2(SYS_mkdir, (i64)path, 0755);
    *s = end;
    if (r < 0 && r != -EEXIST) die("mkdir ", path, r);
    if (!end) return;
  }
}

static void put_text(const char *path, const u8 *text, u64 n) {
  i64 fd = ok(sys3(SYS_open, (i64)path, O_WRONLY | O_CLOEXEC, 0), "open ", path);
  ok(sys3(SYS_write, fd, (i64)text, (i64)n), "write ", path);
  sys1(SYS_close, fd);
}
/* A box's user namespace told who is who in it, by the one that made it: /proc/PID/uid_map and gid_map. */
static void who(i64 pid) {
  u8 path[40], text[LINES * 64];
  static const char proc[] = "/proc/";
  u8 *p = path;
  for (const char *s = proc; *s; s++) *p++ = (u8)*s;
  p = dec(p, (u64)pid);
  for (int gid = 0; gid < 2; gid++) {
    const struct line *l = gid ? c.gids : c.uids;
    u8 *t = text;
    for (u32 i = 0, n = gid ? c.ngids : c.nuids; i < n; i++) {
      t = dec(t, l[i].in), *t++ = ' ';
      t = dec(t, l[i].out), *t++ = ' ';
      t = dec(t, l[i].n), *t++ = '\n';
    }
    /* One who is not root may map only itself, and only once its box may not set groups. */
    if (gid && sys1(SYS_geteuid, 0)) {
      __builtin_memcpy(p, "/setgroups", 11);
      put_text((char *)path, (const u8 *)"deny", 4);
    }
    __builtin_memcpy(p, gid ? "/gid_map" : "/uid_map", 9);
    put_text((char *)path, text, (u64)(t - text));
  }
}

struct mount_attr { u64 set, clear, spread, userns; };
/* What mount(2) calls a flag, as mount_setattr(2) calls it. */
static u64 attr(u64 f) {
  return (f & (MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC)) | (f & MS_NOATIME ? 0x10 : 0) | (f & MS_STRICTATIME ? 0x20 : 0) |
         (f & MS_NODIRATIME ? 0x80 : 0) | (f & MS_NOSYMFOLLOW ? 0x200000 : 0);
}

/* One of config.json's mounts, put in the box's root (which is the root by now). */
static void mount_(struct mount *m) {
  i64 r;
  if (m->tree >= 0) {
    u64 rec = m->flags & MS_REC ? 0x8000 /* AT_RECURSIVE */ : 0;
    struct mount_attr a = {attr(m->flags), attr(m->clear) | (m->flags & (MS_NOATIME | MS_STRICTATIME) || m->clear & (MS_NOATIME | MS_STRICTATIME | MS_RELATIME) ? 0x70 : 0), m->spread & MS_SPREAD, 0};
    if (a.set | a.clear | a.spread)
      ok(sys6(SYS_mount_setattr, m->tree, (i64)"", 0x1000 /* AT_EMPTY_PATH */ | (i64)rec, (i64)&a, sizeof a, 0), "mount: its options: ", m->to);
    /* On what its destination leads to: a link there is followed, in the box's root, as mount(2) follows it. */
    enum { ONTO = 4 /* MOVE_MOUNT_F_EMPTY_PATH */ | 0x10 /* MOVE_MOUNT_T_SYMLINKS */ };
    r = sys6(SYS_move_mount, m->tree, (i64)"", AT_FDCWD, (i64)m->to, ONTO, 0);
    if (r == -ENOENT) {
      /* Nothing is there to mount it on: a directory for a directory, a file for anything else (one made by
       * another run on the same root meanwhile is as good). */
      __attribute__((uninitialized)) struct kstat st;
      ok(sys4(SYS_newfstatat, m->tree, (i64)"", (i64)&st, 0x1000), "stat ", m->from);
      make_dirs(m->to, IS_DIR(st.mode));
      if (!IS_DIR(st.mode) && (r = sys3(SYS_mknod, (i64)m->to, 0100644, 0)) < 0 && r != -EEXIST) die("mknod ", m->to, r);
      r = sys6(SYS_move_mount, m->tree, (i64)"", AT_FDCWD, (i64)m->to, ONTO, 0);
    }
    ok(r, "mount ", m->to);
    return;
  }
  const char *from = m->from ? m->from : m->type;
  if (m->fresh) make_dirs(m->to, 1);
  r = sys6(SYS_mount, (i64)from, (i64)m->to, (i64)m->type, (i64)m->flags, (i64)m->data, 0);
  if (r == -ENOENT) {
    make_dirs(m->to, 1);
    r = sys6(SYS_mount, (i64)from, (i64)m->to, (i64)m->type, (i64)m->flags, (i64)m->data, 0);
  }
  ok(r, "mount ", m->to);
  if (m->spread) ok(sys6(SYS_mount, 0, (i64)m->to, 0, (i64)m->spread, 0, 0), "mount: how it spreads: ", m->to);
}

/* What every box has in /dev: the six devices (made; or, where one in a user namespace may not make them, the
 * host's, `host`: each taken while the host's paths were the host's, and put where it goes), and the names a
 * program looks for. */
static const char NODES[] = "/dev/null\0/dev/zero\0/dev/full\0/dev/random\0/dev/urandom\0/dev/tty\0";
static void devices(const int *host) {
  static const u16 numbers[] = {1 << 8 | 3, 1 << 8 | 5, 1 << 8 | 7, 1 << 8 | 8, 1 << 8 | 9, 5 << 8 | 0};
  static const char links[] =
    "/proc/self/fd\0/dev/fd\0/proc/self/fd/0\0/dev/stdin\0/proc/self/fd/1\0/dev/stdout\0/proc/self/fd/2\0/dev/stderr\0"
    "pts/ptmx\0/dev/ptmx\0";
  const char *path = NODES;
  for (u32 i = 0; *path; i++, path += slen(path) + 1) {
    i64 r;
    for (int again = 0;; again = 1) {
      if (!host) r = sys3(SYS_mknod, (i64)path, 0020666, numbers[i]);
      else {
        r = sys3(SYS_mknod, (i64)path, 0100666, 0);
        if (r >= 0 || r == -EEXIST) r = sys6(SYS_move_mount, host[i], (i64)"", AT_FDCWD, (i64)path, 4 /* MOVE_MOUNT_F_EMPTY_PATH */, 0);
      }
      if (r != -ENOENT || again) break;
      /* (a root with no /dev, and none mounted; another run on the same root may have made it meanwhile) */
      if ((r = sys2(SYS_mkdir, (i64)"/dev", 0755)) < 0 && r != -EEXIST) die("mkdir ", "/dev", r);
    }
    if (r < 0 && r != -EEXIST) die("a device: ", path, r);
  }
  for (const char *to = links; *to;) {
    const char *name = to + slen(to) + 1;
    i64 r = sys2(SYS_symlink, (i64)to, (i64)name);
    if (r < 0 && r != -EEXIST) die("a link: ", name, r);
    to = name + slen(name) + 1;
  }
}

/* ---- The box's terminal: made in the box's own /dev/pts, its name as a program looks for it (/dev/console), the
 * box's process the one it belongs to; its other end sent, with the terminal's name, over the socket the one who
 * asked is listening at, and closed here. Nothing of it is kept: this is where muk ends. */
static i64 console = -1; /* the socket, connected while the host's paths were the host's */
static void connect_console(const char *path) {
  struct { u16 family; char path[108]; } at = {1 /* AF_UNIX */, {0}};
  u64 n = slen(path);
  if (n >= sizeof at.path) fail("--console-socket: its path is longer than a socket's may be: ", path);
  __builtin_memcpy(at.path, path, n);
  console = ok(sys3(SYS_socket, 1, 1 /* SOCK_STREAM */ | O_CLOEXEC, 0), "--console-socket: ", path);
  ok(sys3(SYS_connect, console, (i64)&at, (i64)(2 + n + 1)), "--console-socket: no one is listening at ", path);
}
static void terminal(void) {
  i64 master = ok(sys3(SYS_open, (i64)"/dev/pts/ptmx", O_RDWR | O_NOCTTY | O_CLOEXEC, 0), "process.terminal: ", "the box has no /dev/pts to make one in");
  int unlocked = 0;
  u32 number = 0;
  ok(sys3(SYS_ioctl, master, 0x40045431 /* TIOCSPTLCK */, (i64)&unlocked), "process.terminal: ", "it is not unlocked");
  ok(sys3(SYS_ioctl, master, 0x80045430 /* TIOCGPTN */, (i64)&number), "process.terminal: ", "it has no number");
  i64 it = ok(sys3(SYS_ioctl, master, 0x5441 /* TIOCGPTPEER */, O_RDWR | O_NOCTTY), "process.terminal: ", "it is not opened");
  if (c.rows | c.columns) {
    u16 size[4] = {c.rows, c.columns, 0, 0};
    sys3(SYS_ioctl, it, 0x5414 /* TIOCSWINSZ */, (i64)size);
  }
  u8 name[32] = "/dev/pts/", *end = dec(name + 9, number);
  *end = 0;
  i64 r = sys3(SYS_mknod, (i64)"/dev/console", 0100600, 0);
  if (r < 0 && r != -EEXIST) die("process.terminal: ", "/dev/console", r);
  ok(sys6(SYS_mount, (i64)name, (i64)"/dev/console", 0, MS_BIND, 0, 0), "process.terminal: ", "/dev/console");
  /* Its other end, and its name with it (as every runtime sends them): one message. */
  struct { u64 len; int level, type, fd; } rights = {20, 1 /* SOL_SOCKET */, 1 /* SCM_RIGHTS */, (int)master};
  struct { void *base; u64 len; } said = {name, (u64)(end - name)};
  struct { void *name; u32 name_len; void *said; u64 saids; void *control; u64 control_len; int flags; } message = {0, 0, &said, 1, &rights, 24, 0};
  ok(sys3(SYS_sendmsg, console, (i64)&message, 0), "--console-socket: ", "the terminal's other end is not taken");
  sys1(SYS_close, console), sys1(SYS_close, master);
  /* The box's process is its own session's first, the terminal that session's, and its three descriptors. */
  sys1(SYS_setsid, 0);
  for (i64 fd = 0; fd < 3; fd++) ok(sys2(SYS_dup2, it, fd), "process.terminal: ", "it is not the box's to read and write");
  ok(sys3(SYS_ioctl, 0, 0x540e /* TIOCSCTTY */, 0), "process.terminal: ", "it is not made the box's own");
  if (it > 2) sys1(SYS_close, it);
  if (c.uid) ok(sys3(SYS_fchown, 0, c.uid, -1), "process.terminal: ", "it is not given to the one the box runs as");
}

/* A mount there already made read-only (or with more flags), keeping what its mount may not lose (in a user
 * namespace, the flags the host's mount had). */
static void remount(const char *path, u64 flags) {
  i64 r = sys6(SYS_mount, 0, (i64)path, 0, (i64)(MS_REMOUNT | MS_BIND | flags), 0, 0);
  if (r == -EPERM) {
    u64 fs[15];
    ok(sys2(SYS_statfs, (i64)path, (i64)fs), "statfs ", path);
    u64 has = fs[10];
    flags |= (has & (MS_NOSUID | MS_NODEV | MS_NOEXEC | MS_NOATIME | MS_NODIRATIME)) | (has & 4096 ? MS_RELATIME : 0);
    r = sys6(SYS_mount, 0, (i64)path, 0, (i64)(MS_REMOUNT | MS_BIND | flags), 0, 0);
  }
  ok(r, "read-only: ", path);
}

#include "filter.h"

/* The filter made, and from here on the box's. */
static void filtered(void) {
  struct bpf made[6 + 4 * FILTERED];
  u32 n = filter_program(made);
  struct { u16 len; struct bpf *filter; } program = {(u16)n, made};
  ok(sys3(SYS_seccomp, 1 /* SECCOMP_SET_MODE_FILTER */, 0, (i64)&program), "the filter: ", "it is not set");
}

/* The process itself, in the box: its root made and filled, then who it is and what it may do, then the program. */
__attribute__((noreturn)) static void inside(const u64 *mask, const int *told) {
  i64 r;
  const char *root = c.root ? c.root : "rootfs";
  /* It ends when the one outside does, and goes on only when that one says so: who is who is written from outside
   * first (nothing is done as root in the box before it), and one that was gone before this was asked for says
   * nothing (the pipe's other end is closed here, so its end is read). */
  sys1(SYS_close, told[1]);
  ok(sys2(SYS_prctl, 1 /* PR_SET_PDEATHSIG */, SIGKILL), "PDEATHSIG: ", "not set");
  u8 go;
  if (sys3(SYS_read, told[0], (i64)&go, 1) != 1) leave(1);
  /* What was lent, opened by the one who lent it: this process is that one still, to the host's files, and is in
   * the box's mount namespace already (what is mounted where muk runs is not a box's to take a copy of). */
  for (u32 i = 0; i < nlent; i++) lent[i].fd = (int)ok(sys3(SYS_open, (i64)lent[i].path, O_PATH | O_CLOEXEC, 0), "--lend: ", lent[i].path);
  /* In a user namespace of its own it is that namespace's root, where it has one: who it was when made (the one
   * who runs muk) is no one there, unless that one is who its root is mapped onto. Who it is changed, which
   * clears its end with muk's: asked again, and muk seen to be there still (its end of the pipe is open). */
  if (c.spaces & CLONE_NEWUSER && sys3(SYS_setresgid, 0, 0, 0) + sys3(SYS_setresuid, 0, 0, 0) == 0) {
    ok(sys2(SYS_prctl, 1 /* PR_SET_PDEATHSIG */, SIGKILL), "PDEATHSIG: ", "not set");
    sys3(SYS_fcntl, told[0], 4 /* F_SETFL */, O_NONBLOCK);
    if (!sys3(SYS_read, told[0], (i64)&go, 1)) leave(1);
  }
  /* A network namespace made for it has its loopback up, as runc leaves one it makes: the kernel makes it down, and a
   * box with no capability over its network could not bring it up itself. (One lent is as its lender left it.) */
  if (c.spaces & CLONE_NEWNET) {
    struct { char name[16]; short flags; u8 rest[22]; } lo = {"lo", 0, {0}};
    i64 s = sys3(SYS_socket, 2 /* AF_INET */, 2 /* SOCK_DGRAM */ | O_CLOEXEC, 0);
    if (s >= 0) { /* (a kernel with no IPv4 has no loopback to bring up) */
      ok(sys3(SYS_ioctl, s, 0x8913 /* SIOCGIFFLAGS */, (i64)&lo), "the network: ", "its loopback is not there");
      lo.flags |= 1 /* IFF_UP */;
      ok(sys3(SYS_ioctl, s, 0x8914 /* SIOCSIFFLAGS */, (i64)&lo), "the network: ", "its loopback is not brought up");
      sys1(SYS_close, s);
    }
  }
  i64 old_umask = sys1(SYS_umask, 0);
  /* (put in the cgroup lent it as it was made: its cgroup namespace begins there, so it is made here, in it) */
  if (cgroup && c.spaces & CLONE_NEWCGROUP) ok(sys1(SYS_unshare, CLONE_NEWCGROUP), "the box's cgroup namespace", "");

  /* The root: nothing mounted here spreads out; the root bound on itself, a mount of its own to turn on. */
  ok(sys6(SYS_mount, 0, (i64)"/", 0, MS_SLAVE | MS_REC, 0, 0), "mount: ", "/ is not made the box's own");
  /* The root is the directory that was opened, not what its path leads to by now: a copy of what is mounted there,
   * put on it, and turned on below. */
  int named;
  i64 at = ok(taken(root, O_PATH, &named), "root.path: ", root); /* (what is opened here is closed as the program starts) */
  i64 turned = ok(sys3(SYS_open_tree, at, (i64)"", 0x1000 /* AT_EMPTY_PATH */ | 1 /* OPEN_TREE_CLONE */ | 0x8000 /* AT_RECURSIVE */ | O_CLOEXEC), "root.path: ", root);
  ok(sys6(SYS_move_mount, turned, (i64)"", at, (i64)"", 4 /* MOVE_MOUNT_F_EMPTY_PATH */ | 0x40 /* MOVE_MOUNT_T_EMPTY_PATH */, 0), "root.path: ", root);
  /* (one in a user namespace may not make devices, and is given a /proc or a /sys on terms) */
  int user = c.user, host[6];
  /* What binds take from the host, while the host's paths are the host's. */
  for (u32 i = 0; i < c.nmounts; i++) {
    struct mount *m = &c.mounts[i];
    /* One in a user namespace is given a new /proc or /sys only where it sees one whole already (a new one then
     * shows it nothing that was covered): made here, over the host's while that is still seen, and carried into
     * the box as a bind is. */
    if (user && m->type && !(m->flags & MS_BIND) && (same(m->type, "proc") || same(m->type, "sysfs"))) {
      const char *over = m->type[0] == 'p' ? "/proc" : "/sys";
      ok(sys6(SYS_mount, (i64)(m->from ? m->from : m->type), (i64)over, (i64)m->type, (i64)m->flags, (i64)m->data, 0), "mount ", m->to);
      m->tree = (int)ok(sys3(SYS_open_tree, AT_FDCWD, (i64)over, 1 /* OPEN_TREE_CLONE */ | O_CLOEXEC), "mount ", m->to);
      m->flags = m->clear = m->spread = 0; /* (its options are on it already) */
      continue;
    }
    /* A box's view of its cgroup: the one tree mounted, where the host has one tree and the box may mount it (it
     * has a cgroup namespace, or is no user namespace's); else what the host has there, bound. */
    if (m->type && same(m->type, "cgroup")) {
      u64 fs[15];
      i64 one = !sys2(SYS_statfs, (i64)"/sys/fs/cgroup", (i64)fs) && fs[0] == 0x63677270;
      if (one && (c.spaces & CLONE_NEWCGROUP || !(c.spaces & CLONE_NEWUSER))) m->type = "cgroup2"; /* (its source is a name and no more) */
      else {
        m->flags |= MS_BIND | MS_REC;
        m->tree = (int)ok(sys3(SYS_open_tree, AT_FDCWD, (i64)"/sys/fs/cgroup", 1 /* OPEN_TREE_CLONE */ | O_CLOEXEC | 0x8000), "mount ", m->to);
      }
      continue;
    }
    if (!(m->flags & MS_BIND)) continue;
    if (!m->from) bad("a bind has no source");
    at = ok(taken(m->from, O_PATH, &named), "mount: its source: ", m->from);
    /* A device is a box's where the one who lent it named that very device: no other file of a bind is one. And
     * the host's own /proc or /sys, lent to one that can be the host's root, is read and not written. */
    __attribute__((uninitialized)) struct kstat st;
    if (named) ok(sys4(SYS_newfstatat, at, (i64)"", (i64)&st, 0x1000), "stat ", m->from);
    if (!named || ((st.mode & 0170000) != 0020000 && (st.mode & 0170000) != 0060000)) m->flags |= MS_NODEV, m->clear &= ~(u64)MS_NODEV;
    if (c.host) {
      u64 fs[15];
      ok(sys2(SYS_fstatfs, at, (i64)fs), "statfs ", m->from);
      if (fs[0] == 0x9fa0 /* proc */ || fs[0] == 0x62656572 /* sysfs */) m->flags |= MS_RDONLY, m->clear &= ~(u64)MS_RDONLY;
    }
    m->tree = (int)ok(sys3(SYS_open_tree, at, (i64)"", 0x1000 /* AT_EMPTY_PATH */ | 1 /* OPEN_TREE_CLONE */ | O_CLOEXEC | (m->flags & MS_REC ? 0x8000 : 0)), "mount: its source: ", m->from);
  }
  if (c.terminal) connect_console(c.console);
  /* (and the host's devices, for one who may not make them) */
  if (c.dev && user) {
    const char *path = NODES;
    for (u32 i = 0; *path; i++, path += slen(path) + 1)
      host[i] = (int)ok(sys3(SYS_open_tree, AT_FDCWD, (i64)path, 1 /* OPEN_TREE_CLONE */ | O_CLOEXEC), "a device: the host's: ", path);
  }
  /* The root made the root. The host's is still there, under the same name: put on the box's, where `..` at the
   * box's root would step onto it. It is taken away before any path is looked up in the box, so that a path there
   * (a mount's destination, a link the root holds, however far up it says to go) leads nowhere but the box. */
  ok(sys1(SYS_fchdir, turned), "root.path: ", root);
  ok(sys2(SYS_pivot_root, (i64)".", (i64)"."), "pivot_root ", root);
  ok(sys2(SYS_umount2, (i64)".", MNT_DETACH), "umount: ", "the host's root");

  for (u32 i = 0; i < c.nmounts; i++) mount_(&c.mounts[i]);
  if (c.dev) devices(user ? host : 0);
  if (c.terminal) terminal();
  /* Where it runs: made, as root and before the root is read-only, if nothing is there; entered now, and again as
   * the one it runs as where root itself may not (a user namespace's root, of a directory that is no one's it knows). */
  r = sys1(SYS_chdir, (i64)c.cwd);
  if (r == -ENOENT) make_dirs(c.cwd, 1), r = sys1(SYS_chdir, (i64)c.cwd);
  if (r < 0 && r != -EACCES) die("process.cwd: ", c.cwd, r);
  int later = r < 0;

  /* (what a path is hidden by is there: where the /dev is not muk's making, one that is not there is said, not
   * taken for a path with nothing to hide) */
  if (!c.dev && c.nmasked) {
    __attribute__((uninitialized)) struct kstat st;
    ok(sys4(SYS_newfstatat, AT_FDCWD, (i64)"/dev/null", (i64)&st, 0), "maskedPaths: ", "the box has no /dev/null to hide them by");
  }
  for (u32 i = 0; i < c.nmasked; i++) {
    r = sys6(SYS_mount, (i64)"/dev/null", (i64)c.masked[i], 0, MS_BIND, 0, 0);
    if (r == -ENOTDIR) r = sys6(SYS_mount, (i64)"tmpfs", (i64)c.masked[i], (i64)"tmpfs", MS_RDONLY, (i64)"size=0k", 0);
    if (r < 0 && r != -ENOENT) die("maskedPaths: ", c.masked[i], r);
  }
  for (u32 i = 0; i < c.nreadonly; i++) {
    r = sys6(SYS_mount, (i64)c.readonly[i], (i64)c.readonly[i], 0, MS_BIND | MS_REC, 0, 0);
    if (r == -ENOENT) continue;
    ok(r, "readonlyPaths: ", c.readonly[i]);
    remount(c.readonly[i], MS_RDONLY | MS_REC);
  }
  /* (the floor: no file of the root is a device, whatever the root holds) */
  remount("/", MS_NODEV | (c.read_only ? MS_RDONLY : 0));
  sys1(SYS_umask, c.umask >= 0 ? c.umask : old_umask);

  if (c.hostname) ok(sys2(SYS_sethostname, (i64)c.hostname, (i64)slen(c.hostname)), "hostname: ", c.hostname);
  if (c.domainname) ok(sys2(SYS_setdomainname, (i64)c.domainname, (i64)slen(c.domainname)), "domainname: ", c.domainname);
  /* (a limit is at most the one muk itself runs under: the lender's, which no box raises) */
  for (u32 i = 0; i < c.nlimits; i++) {
    u64 was[2];
    ok(sys4(SYS_prlimit64, 0, c.limits[i].what, (i64)&c.limits[i].now, (i64)was), "rlimits: ", "one is not set");
    if (c.limits[i].most > was[1]) fail("config.json: process.rlimits: ", "one is more than the one who runs muk has, which is the most a box has");
  }

  /* Who it is and what it may do: what it may never gain first, while that may still be given up. */
  for (i64 cap = 0; cap < 64; cap++) {
    if (c.caps[0] >> cap & 1) continue;
    r = sys2(SYS_prctl, 24 /* PR_CAPBSET_DROP */, cap);
    if (r == -EINVAL) break; /* (past the kernel's last) */
    ok(r, "capabilities: ", "the bounding set is not dropped");
  }
  if (c.uid) sys2(SYS_prctl, 8 /* PR_SET_KEEPCAPS */, 1);
  r = sys2(SYS_setgroups, c.ngroups, (i64)c.groups);
  if (r < 0 && (c.ngroups || r != -EPERM)) die("user: ", "its groups are not set", r);
  ok(sys3(SYS_setresgid, c.gid, c.gid, c.gid), "user: ", "its gid is not set");
  ok(sys3(SYS_setresuid, c.uid, c.uid, c.uid), "user: ", "its uid is not set");
  {
    struct { u32 version; int pid; } head = {0x20080522, 0};
    struct { u32 effective, permitted, inheritable; } sets[2];
    for (int i = 0; i < 2; i++)
      sets[i].effective = (u32)(c.caps[1] >> 32 * i), sets[i].permitted = (u32)(c.caps[2] >> 32 * i), sets[i].inheritable = (u32)(c.caps[3] >> 32 * i);
    ok(sys2(SYS_capset, (i64)&head, (i64)sets), "capabilities: ", "they are not set");
    for (i64 cap = 0; cap < 64; cap++)
      if (c.caps[4] >> cap & 1) ok(sys6(SYS_prctl, 47 /* PR_CAP_AMBIENT */, 2 /* RAISE */, cap, 0, 0, 0), "capabilities: ", "an ambient one is not raised");
  }
  ok(sys6(SYS_prctl, 38 /* PR_SET_NO_NEW_PRIVS */, 1, 0, 0, 0, 0), "no_new_privs", "");
  ok(sys2(SYS_prctl, 1, SIGKILL), "PDEATHSIG: ", "not set"); /* (again: who it is changed, which clears it) */

  /* HOME, where the box's own /etc/passwd has the one it runs as (as runc gives it), when it is given none. */
  int home = 0;
  for (u32 i = 0; i < c.nenv; i++) home |= c.env[i][0] == 'H' && c.env[i][1] == 'O' && c.env[i][2] == 'M' && c.env[i][3] == 'E' && c.env[i][4] == '=';
  if (!home && c.nenv < WORDS - 1) {
    /* ("HOME=/" stands by itself, before where the file is read: it is what is given unless the file has the one) */
    u8 *text = grab((64 << 10) + 16), *at = text + 8;
    __builtin_memcpy(text, "HOME=/", 7);
    /* (the box's file, and so anything: a pipe is not waited on, a terminal not taken for this one's) */
    i64 fd = sys3(SYS_open, (i64)"/etc/passwd", O_RDONLY | O_CLOEXEC | O_NONBLOCK | O_NOCTTY, 0), n = fd < 0 ? 0 : sys3(SYS_read, fd, (i64)at, 64 << 10);
    if (fd >= 0) sys1(SYS_close, fd);
    if (n > 0) at[n] = '\n';
    for (u8 *l = at, *end = at + (n > 0 ? n : 0); l < end;) { /* name:x:uid:gid:what:home:shell */
      u8 *f[7], *e = l;
      u32 nf = 0;
      for (f[nf++] = l; *e != '\n'; e++)
        if (*e == ':' && nf < 7) f[nf++] = e + 1;
      u64 uid = 0;
      u8 *d = nf > 5 ? f[2] : e;
      while (*d >= '0' && *d <= '9') uid = uid * 10 + (u64)(*d++ - '0');
      u64 len = nf > 5 ? (u64)((nf > 6 ? f[6] - 1 : e) - f[5]) : 0;
      if (len && d == f[3] - 1 && d > f[2] && uid == c.uid) {
        text = f[5] - 5;
        __builtin_memcpy(text, "HOME=", 5);
        text[5 + len] = 0;
        break;
      }
      l = e + 1;
    }
    c.env[c.nenv++] = (char *)text, c.env[c.nenv] = 0;
  }
  if (later) ok(sys1(SYS_chdir, (i64)c.cwd), "process.cwd: ", c.cwd);
  ok(sys3(SYS_close_range, 3, ~0u, 4 /* CLOSE_RANGE_CLOEXEC */), "descriptors: ", "not closed across exec");
  ok(sys4(SYS_rt_sigprocmask, 2 /* SIG_SETMASK */, (i64)mask, 0, 8), "signals: ", "not restored");
  filtered(); /* (last: what is done above is what a box may not do) */

  /* The program: as it is named, or where PATH (the box's) has it. */
  char *name = c.args[0];
  int plain = 1;
  for (char *s = name; *s; s++) plain &= *s != '/';
  if (!plain) r = sys3(SYS_execve, (i64)name, (i64)c.args, (i64)c.env);
  else {
    const char *path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    for (u32 i = 0; i < c.nenv; i++)
      if (c.env[i][0] == 'P' && c.env[i][1] == 'A' && c.env[i][2] == 'T' && c.env[i][3] == 'H' && c.env[i][4] == '=') path = c.env[i] + 5;
    u64 n = slen(name);
    u8 *at = grab(slen(path) + n + 2); /* (the longest of PATH's places is no longer than all of it) */
    r = -ENOENT;
    while (*path) {
      const char *end = path;
      while (*end && *end != ':') end++;
      u8 *p = at;
      for (const char *s = path; s < end; s++) *p++ = (u8)*s;
      if (p > at) *p++ = '/';
      __builtin_memcpy(p, name, n + 1);
      i64 e = sys3(SYS_execve, (i64)at, (i64)c.args, (i64)c.env);
      if (e != -ENOENT && e != -ENOTDIR) r = e; /* (the one worth saying: it is there, and is not run) */
      path = *end ? end + 1 : end;
    }
  }
  die("exec ", name, r);
}

static int main_(int argc, char **argv, char **envp) {
  static const char usage[] = "muk run [-b BUNDLE] [--console-socket PATH] [--lend PATH]... [--ids FIRST-LAST] [--cgroup DIR] [ID]";
  const char *bundle = 0;
  int i = 2;
  if (argc < 2 || !same(argv[1], "run")) fail("usage: ", usage);
  /* One who is not root is lent, by the kernel, the user it is and no other: nothing is left for muk to hold it
   * to. (Who runs it is what the kernel said as it started it: what follows the environment.) */
  char **aux = envp;
  while (*aux) aux++;
  for (u64 *a = (u64 *)(aux + 1); a[0]; a += 2)
    if (a[0] == 12 /* AT_EUID */ && a[1]) ids_first = 0, ids_last = ~0ull;
  for (; i + 1 < argc && argv[i][0] == '-'; i += 2) {
    char *word = argv[i + 1];
    if (same(argv[i], "-b") || same(argv[i], "--bundle")) bundle = word;
    else if (same(argv[i], "--console-socket")) c.console = word;
    else if (same(argv[i], "--cgroup")) cgroup = word;
    else if (same(argv[i], "--lend")) {
      if (nlent == 16 || word[0] != '/') fail("--lend: a path from the root, and sixteen of them at most: ", word);
      u32 n = (u32)slen(word);
      while (n && word[n - 1] == '/') n--;
      lent[nlent].path = word, lent[nlent].n = n, lent[nlent++].fd = -1;
    } else if (same(argv[i], "--ids")) {
      u64 v[2] = {0, 0};
      char *d = word;
      for (int k = 0; k < 2; k++) {
        char *from = d;
        while (*d >= '0' && *d <= '9' && v[k] <= ID) v[k] = v[k] * 10 + (u64)(*d++ - '0');
        if (d == from || v[k] > ID || *d != (k ? 0 : '-')) fail("--ids: the first and the last of the host's users and groups lent, as FIRST-LAST: ", word);
        d++;
      }
      ids_first = v[0], ids_last = v[1];
    } else fail("usage: ", usage);
  }
  /* (what is left is the box's name, one word and no option: nothing given is passed over unread) */
  if (i < argc && (argv[i][0] == '-' || i + 1 < argc)) fail("usage: ", usage);
  if (bundle) ok(sys1(SYS_chdir, (i64)bundle), "the bundle: ", bundle);

  i64 fd = ok(sys3(SYS_open, (i64)"config.json", O_RDONLY | O_CLOEXEC, 0), "open ", "config.json");
  if (fd < 3) {
    /* It was started with standard input, output or error closed, and what it opens would take their places (the
     * box's too): they are given the place nothing is read from and nothing written to keeps, and this is opened
     * again past them. */
    sys1(SYS_close, fd);
    do fd = ok(sys3(SYS_open, (i64)"/dev/null", O_RDWR, 0), "open ", "/dev/null"); while (fd < 3);
    sys1(SYS_close, fd);
    fd = ok(sys3(SYS_open, (i64)"config.json", O_RDONLY | O_CLOEXEC, 0), "open ", "config.json");
  }
  enum { MOST = 1 << 20 };
  u8 *text = grab(MOST + 16); /* (sixteen past its end, for a string's end to be looked for there) */
  i64 n = 0, got; /* (read to its end: one read is all of a file, and not all of a pipe) */
  while ((got = ok(sys3(SYS_read, fd, (i64)(text + n), MOST - n), "read ", "config.json")) > 0) n += got;
  if (n == MOST) bad("it is longer than is read");
  sys1(SYS_close, fd);
  text[n] = 0, j = text, jend = text + n;
  config(ids_first, ids_last);
  /* A terminal's other end is someone's or there is no terminal: muk keeps none. */
  if (c.terminal && !c.console) bad("process.terminal: its other end goes to the one who asks for it, and no one has (--console-socket)");
  if (!c.terminal && c.console) fail("--console-socket: ", "config.json asks for no terminal (process.terminal)");

  /* The namespaces it joins (the user's first: it says what one may do in the others). What is in them already
   * can see the box's process from the moment it is made, while it is still this program and holds the host's
   * root: it is made as one that may not be traced or read through /proc, until it is the box's program. */
  int hidden = 0;
  for (int user = 1; user >= 0; user--)
    for (u32 k = 0; k < c.njoined; k++) {
      if ((c.joined[k].flag == CLONE_NEWUSER) != user) continue;
      /* One that was lent, by its path; and, the network's apart, never the one muk itself is in: the host's. */
      int named;
      fd = ok(taken(c.joined[k].path, O_RDONLY, &named), "linux.namespaces: its path: ", c.joined[k].path);
      if (c.joined[k].flag != CLONE_NEWNET) {
        static const char NAMES[][8] = {"mnt", "cgroup", "uts", "ipc", "user", "pid"};
        char own[24] = "/proc/self/ns/";
        u32 kind = 0;
        while (SPACE[kind] != c.joined[k].flag) kind++;
        __builtin_memcpy(own + 14, NAMES[kind], 8);
        __attribute__((uninitialized)) struct kstat its, mine;
        ok(sys4(SYS_newfstatat, fd, (i64)"", (i64)&its, 0x1000 /* AT_EMPTY_PATH */), "stat ", c.joined[k].path);
        ok(sys4(SYS_newfstatat, AT_FDCWD, (i64)own, (i64)&mine, 0), "stat ", own);
        if (its.dev == mine.dev && its.ino == mine.ino) fail("config.json: linux.namespaces: the host's own is no box's to join: ", c.joined[k].path);
      }
      else {
        /* The network muk itself is in, lent: the box is in it by being made here, and there is nothing to join
         * (one who is not root may join none, its own neither: the kernel asks a privilege over it for the asking). */
        __attribute__((uninitialized)) struct kstat its, mine;
        ok(sys4(SYS_newfstatat, fd, (i64)"", (i64)&its, 0x1000 /* AT_EMPTY_PATH */), "stat ", c.joined[k].path);
        ok(sys4(SYS_newfstatat, AT_FDCWD, (i64)"/proc/self/ns/net", (i64)&mine, 0), "stat ", "/proc/self/ns/net");
        if (its.dev == mine.dev && its.ino == mine.ino) { sys1(SYS_close, fd); continue; }
      }
      if (!hidden) ok(sys2(SYS_prctl, 4 /* PR_SET_DUMPABLE */, 0), "dumpable: ", "not cleared before joining"), hidden = 1;
      ok(sys2(SYS_setns, fd, c.joined[k].flag), "setns ", c.joined[k].path);
      sys1(SYS_close, fd);
    }

  /* Every signal is waited for, not taken: one sent to muk is passed on, and the box's end is one of them. */
  u64 all = ~0ull, mask = 0;
  ok(sys4(SYS_rt_sigprocmask, 0 /* SIG_BLOCK */, (i64)&all, (i64)&mask, 8), "signals: ", "not blocked");
  int told[2];
  ok(sys2(SYS_pipe2, (i64)told, O_CLOEXEC), "pipe", "");
  /* Made in the cgroup lent it, where one is: what the box may use of the machine (its processes, its memory, its
   * share of the processors) is what that cgroup may, set by the one who made it, and the box is never out of
   * it. (Its cgroup namespace begins where it is when made: made by the box itself, once in.) */
  i64 pid;
  if (cgroup) {
    i64 into = ok(sys3(SYS_open, (i64)cgroup, O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0), "--cgroup: ", cgroup);
    struct { u64 flags, pidfd, child_tid, parent_tid, exit_signal, stack, stack_size, tls, set_tid, set_tid_size, cgroup; } how = {
      (c.spaces & ~(u64)CLONE_NEWCGROUP) | 0x200000000ull /* CLONE_INTO_CGROUP */, 0, 0, 0, SIGCHLD, 0, 0, 0, 0, 0, (u64)into};
    pid = ok(sys2(SYS_clone3, (i64)&how, sizeof how), "--cgroup: the box is not made in it: ", cgroup);
    if (pid) sys1(SYS_close, into);
  } else pid = ok(sys6(SYS_clone, (i64)(c.spaces | SIGCHLD), 0, 0, 0, 0, 0), "clone: ", "the box's namespaces are not made");
  if (!pid) inside(&mask, told);
  if (c.spaces & CLONE_NEWUSER) who(pid);
  sys3(SYS_write, told[1], (i64)"", 1);
  for (;;) {
    struct { int signo, error, code; u8 rest[116]; } info;
    i64 sig = sys4(SYS_rt_sigtimedwait, (i64)&all, (i64)&info, 0, 8);
    if (sig == -EINTR) continue;
    if (sig < 0) die("signals: ", "not waited for", sig);
    if (sig == SIGCHLD) {
      int status = 0;
      if (sys4(SYS_wait4, pid, (i64)&status, 1 /* WNOHANG */, 0) == pid) return status & 0x7f ? 128 + (status & 0x7f) : status >> 8 & 0xff;
    } else if (sig > 0 && info.code <= 0) sys2(SYS_kill, pid, sig); /* (one a process sent: what the terminal sends, the box has had) */
  }
}

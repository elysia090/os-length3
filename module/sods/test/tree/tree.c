/*
 * The tree beside Linux: a directory made a tree (as what makes a root's index will make it), then every name in it
 * asked of both, spelled every way a path is (a slash after it, "." and ".." after it, a name that is not there, its
 * slashes doubled, from its own directory, with links followed and not), and the two say the same: the same file (its
 * inode on the host), or the same refusal. Linux is asked by openat2 with the directory as the root
 * (RESOLVE_IN_ROOT), which walks it as a process whose root it is would.
 *
 *   tree DIR             every name of DIR, every spelling: "ok N", or the first two that differ
 *   tree DIR walks N     N walks of its names and no more (for callgrind: what one walk costs)
 */
#define UNIT "tree"
#define ARENA (256 << 20)
#include "../../../lib/io.h"
#include "../../lib/tree.h"

enum { SYS_readlinkat = 267, SYS_openat2 = 437, O_DIRECTORY = 0200000, O_NOFOLLOW = 0400000, O_PATH = 010000000 };
enum { MOST = 1 << 20 };

static struct tree_node *nodes;
static u64 *inodes; /* each node's inode on the host: what Linux is compared by */
static u32 *owners;
static u8 *names;
static u32 count, names_len;

static u32 name_in(const u8 *s, u32 n) {
  u32 at = names_len;
  if (names_len + n + SLACK > (32u << 20)) fail("too many names", "");
  __builtin_memcpy(names + at, s, n);
  names_len += n;
  return at;
}

/* DIR's entries, the directories among them after it, side by side: each directory's entries are next to each other. */
static void take(const char *dir) {
  u8 *path = grab(8192), *ents = grab(1 << 16), *target = grab(4096);
  __attribute__((uninitialized)) struct kstat top;
  if (sys4(SYS_newfstatat, AT_FDCWD, (i64)dir, (i64)&top, 0) < 0 || !TREE_IS(top.mode, TREE_DIR)) fail("not a directory: ", dir);
  nodes[0] = (struct tree_node){.mode = top.mode, .nlink = (u16)top.nlink, .same = 0, .mtime = (u32)top.times[2]};
  inodes[0] = top.ino, owners[0] = top.uid << 16 | (top.gid & 0xffff);
  count = 1;
  for (u32 d = 0; d < count; d++) {
    if (!TREE_IS(nodes[d].mode, TREE_DIR)) continue;
    /* Its path on the host: the names from the root down. */
    u32 up[256], depth = 0;
    for (u32 n = d; n; n = nodes[n].parent) up[depth++] = n;
    u64 len = slen(dir);
    __builtin_memcpy(path, dir, len);
    while (depth) {
      const struct tree_node *n = &nodes[up[--depth]];
      path[len++] = '/';
      __builtin_memcpy(path + len, names + n->name, n->name_len), len += n->name_len;
    }
    path[len] = 0;
    i64 fd = sys3(SYS_open, (i64)path, O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0);
    if (fd < 0) fail("open ", (char *)path);
    nodes[d].at = count;
    for (i64 got; (got = sys3(SYS_getdents64, fd, (i64)ents, 1 << 16)) > 0;)
      for (u8 *e = ents; e < ents + got; e += ld16(e + 16)) {
        const char *name = (const char *)e + 19;
        if (name[0] == '.' && (!name[1] || (name[1] == '.' && !name[2]))) continue;
        __attribute__((uninitialized)) struct kstat st;
        if (sys4(SYS_newfstatat, fd, (i64)name, (i64)&st, 0x100) < 0) fail("stat ", name);
        if (count == MOST) fail("too many names", "");
        struct tree_node *n = &nodes[count];
        u32 nl = (u32)slen(name);
        *n = (struct tree_node){.mode = st.mode, .size = (u32)st.size, .name = name_in((const u8 *)name, nl), .parent = d,
                                .name_len = (u16)nl, .nlink = (u16)st.nlink, .same = count, .mtime = (u32)st.times[2]};
        inodes[count] = st.ino, owners[count] = st.uid << 16 | (st.gid & 0xffff);
        if (TREE_IS(st.mode, TREE_LINK)) {
          i64 tl = sys4(SYS_readlinkat, fd, (i64)name, (i64)target, 4095);
          if (tl < 0) fail("readlink ", name);
          n->at = name_in(target, (u32)tl), n->size = (u32)tl;
        } else if (st.nlink > 1 && !TREE_IS(st.mode, TREE_DIR)) {
          for (u32 o = 1; o < count; o++)
            if (inodes[o] == st.ino && !TREE_IS(nodes[o].mode, TREE_DIR)) { n->same = nodes[o].same; break; }
        }
        count++;
      }
    sys1(SYS_close, fd);
    nodes[d].size = count - nodes[d].at;
  }
}

/* The tree's bytes, as tree.h lays them out. */
static const u8 *made(u64 *bytes) {
  u32 slots = 4;
  while (slots < 2 * count) slots *= 2;
  *bytes = tree_bytes(count, slots, names_len);
  u8 *out = grab(*bytes);
  struct tree_head *h = (struct tree_head *)out;
  __builtin_memcpy(h->magic, "ricetree", 8);
  h->nodes = count, h->slots = slots, h->names = names_len;
  u8 *p = out + sizeof *h;
  __builtin_memcpy(p, nodes, (u64)count * 32), p += (u64)count * 32;
  u64 *table = (u64 *)p;
  for (u32 n = 1; n < count; n++) { /* (the root has no name to be found by) */
    u64 hash = tree_hash(nodes[n].parent, names + nodes[n].name, nodes[n].name_len);
    u32 i = tree_slot(hash, slots);
    while (table[i]) i = (i + 1) & (slots - 1);
    table[i] = hash << 32 | (n + 1);
  }
  p += (u64)slots * 8;
  __builtin_memcpy(p, owners, (u64)count * 4), p += ((u64)count * 4 + 7) & ~7ull;
  __builtin_memcpy(p, names, names_len);
  return out;
}

static i64 root; /* DIR, open */
/* What Linux says of `path` in DIR as the root: the inode it names, or what it refuses with. */
static i64 linux_says(const u8 *path, int follow) {
  struct { u64 flags, mode, resolve; } how = {O_PATH | O_CLOEXEC | (follow ? 0 : O_NOFOLLOW), 0, 0x10 /* RESOLVE_IN_ROOT */};
  i64 fd = sys4(SYS_openat2, root, (i64)path, (i64)&how, sizeof how);
  if (fd < 0) return fd;
  __attribute__((uninitialized)) struct kstat st;
  sys4(SYS_newfstatat, fd, (i64)"", (i64)&st, 0x1000);
  sys1(SYS_close, fd);
  return (i64)st.ino;
}

static u64 asked;
static void same_as_linux(const struct tree *t, u32 from, const u8 *from_path, u64 from_len, const u8 *path, u64 len, int follow) {
  /* For Linux, the path from the root: where it starts, then it (a path that begins with a slash is from the root). */
  u8 *whole = grab(from_len + len + 16);
  u64 n = 0;
  if (!len || path[0] != '/') __builtin_memcpy(whole, from_path, from_len), n = from_len, whole[n++] = '/';
  __builtin_memcpy(whole + n, path, len), whole[n + len] = 0;
  i64 want = len ? linux_says(whole, follow) : -TREE_NOENT, got = tree_walk(t, from, path, len, follow);
  if (got >= 0) got = (i64)inodes[got];
  asked++;
  if (want == got) { used -= (from_len + len + 16 + SLACK + 15) & ~15ul; return; }
  u8 *m = grab(64), *e = m;
  static const char a[] = " (Linux ", b[] = ", the tree ";
  for (const char *s = a; *s; s++) *e++ = (u8)*s;
  if (want < 0) *e++ = '-', want = -want;
  u8 d[20]; u32 k = 0;
  do d[k++] = (u8)('0' + want % 10); while (want /= 10);
  while (k) *e++ = d[--k];
  for (const char *s = b; *s; s++) *e++ = (u8)*s;
  if (got < 0) *e++ = '-', got = -got;
  do d[k++] = (u8)('0' + got % 10); while (got /= 10);
  while (k) *e++ = d[--k];
  *e++ = ')', *e++ = follow ? '+' : '-', *e = 0;
  sys3(SYS_write, 2, (i64)whole, (i64)(n + len));
  fail("", (char *)m);
}

static int main_(int argc, char **argv, char **envp) {
  (void)envp;
  if (argc < 2) fail("usage: ", "tree DIR [walks N]");
  nodes = (struct tree_node *)grab((u64)MOST * 32), inodes = (u64 *)grab((u64)MOST * 8), owners = (u32 *)grab((u64)MOST * 4);
  names = grab(32 << 20);
  take(argv[1]);
  u64 bytes;
  const u8 *image = made(&bytes);
  struct tree t;
  if (!tree_open(&t, image, bytes)) fail("the tree made is not one", "");
  if (tree_open(&t, image, bytes - 1) || !tree_open(&t, image, bytes)) fail("a tree cut short is taken for one", "");
  root = sys3(SYS_open, (i64)argv[1], O_PATH | O_DIRECTORY | O_CLOEXEC, 0);
  if (root < 0) fail("open ", argv[1]);

  /* Each name's path from the root, once. */
  u8 **paths = (u8 **)grab((u64)count * 8);
  u32 *lens = (u32 *)grab((u64)count * 4);
  for (u32 n = 0; n < count; n++) {
    u32 up[256], depth = 0;
    u64 len = 0;
    for (u32 k = n; k; k = nodes[k].parent) up[depth++] = k, len += nodes[k].name_len + 1u;
    u8 *p = paths[n] = grab(len + 1);
    lens[n] = (u32)len;
    while (depth) {
      const struct tree_node *k = &nodes[up[--depth]];
      *p++ = '/';
      __builtin_memcpy(p, names + k->name, k->name_len), p += k->name_len;
    }
    *p = 0;
  }

  if (argc >= 4 && same(argv[2], "walks")) {
    u64 walks = 0, found = 0;
    for (const char *s = argv[3]; *s; s++) walks = walks * 10 + (u64)(*s - '0');
    for (u64 i = 0; i < walks; i++) found += tree_walk(&t, 0, paths[1 + i % (count - 1)], lens[1 + i % (count - 1)], 1) >= 0;
    return found ? 0 : 1; /* (dangling links are not found; most names are) */
  }

  u8 *spelled = grab(2 * 8192);
  for (u32 n = 0; n < count; n++) {
    const u8 *p = paths[n];
    u32 len = lens[n], dir = nodes[n].parent;
    static const char tails[] = "\0/\0/.\0/..\0/no-such\0//\0/./..//.\0";
    for (int follow = 0; follow < 2; follow++) {
      const char *tail = tails;
      for (int i = 0; i < 7; i++, tail += slen(tail) + 1) {
        u64 tl = slen(tail);
        __builtin_memcpy(spelled, p, len), __builtin_memcpy(spelled + len, tail, tl + 1);
        if (len + tl) same_as_linux(&t, 0, (const u8 *)"", 0, spelled, len + tl, follow);
      }
      /* Its slashes doubled, and a "." between them. */
      u64 k = 0;
      for (u32 i = 0; i < len; i++) {
        spelled[k++] = p[i];
        if (p[i] == '/') spelled[k++] = '/', spelled[k++] = '.', spelled[k++] = '/';
      }
      spelled[k] = 0;
      if (k) same_as_linux(&t, 0, (const u8 *)"", 0, spelled, k, follow);
      if (!n) continue;
      /* From its own directory: its name alone, and out of the directory and in again. */
      same_as_linux(&t, dir, paths[dir], lens[dir], names + nodes[n].name, nodes[n].name_len, follow);
      k = 0;
      __builtin_memcpy(spelled, "../", 3), k = 3;
      if (dir) __builtin_memcpy(spelled + k, names + nodes[dir].name, nodes[dir].name_len), k += nodes[dir].name_len, spelled[k++] = '/';
      __builtin_memcpy(spelled + k, names + nodes[n].name, nodes[n].name_len), k += nodes[n].name_len, spelled[k] = 0;
      same_as_linux(&t, dir, paths[dir], lens[dir], spelled, k, follow);
    }
  }
  /* An empty path, and a name longer than a name may be. */
  same_as_linux(&t, 0, (const u8 *)"", 0, (const u8 *)"", 0, 1);
  for (u32 i = 0; i < 300; i++) spelled[i] = 'x';
  spelled[0] = '/', spelled[300] = 0;
  same_as_linux(&t, 0, (const u8 *)"", 0, spelled, 300, 1);

  u8 *m = piece();
  u32 k = 0;
  u8 d[20]; u32 dn = 0;
  u64 v = asked;
  do d[dn++] = (u8)('0' + v % 10); while (v /= 10);
  while (dn) m[k++] = d[--dn];
  put("ok ", 3), put(m, k), put("\n", 1);
  flush();
  return 0;
}

/*
 * The tree: names to nodes. A root's index as bytes, used where it is: nothing is read into anything when a root is
 * mounted, and a name is found by one look in a table. The first of the kernel's parts written to its bound (docs/
 * STRUCTURE.md); on lib's words alone, with no call into any kernel, so it is the same code on Linux (where its test
 * puts it beside Linux's own walk of the same directory, tests/tree) and as wasm.
 *
 *   head     32 bytes    "ricetree", how many nodes, how many slots (a power of two, more than the nodes), bytes of names
 *   nodes    32 each     what a name is: its kind and mode, its size, where its bytes are, its name, its directory
 *   slots     8 each     the table: a name's hash (its low half) in the high half, its node (and one) in the low; 0 where
 *                        there is none
 *   owners    4 each     uid in the high half, gid in the low (read by stat alone, so not in a node)
 *   names                every name and every link's target, one after another, SLACK after the last
 *
 * A directory's entries are the nodes from `at`, `size` of them, side by side: it is listed by walking them. A file
 * with more than one name is a node for each, `same` the first of them. The root is node 0, and its own directory.
 *
 * What a walk costs: a name's bytes are read once, eight at a time, for its end and its hash together; one slot is
 * read and its half of the hash compared; then the node's directory and the name's length, and the name's bytes as
 * a word: three lines of memory a name (the slot, the node, the name). By hand about 50 instructions a name;
 * measured, 100: a path of a whole root (12,019 names, 8.6 looked up a path with the links it goes through) is 875
 * instructions, 74 ns. The whole root's tree is 814 KB, and mounting it is nothing.
 *
 * It is used only once its bytes are known to be the root's (their digest checked, as every byte of a root is); a
 * tree that is not what its maker wrote is still walked without reading outside it, and every walk ends.
 */
#pragma once
#include "../../../lib/word.h"

struct tree_head { u8 magic[8]; u32 nodes, slots, names, unused[3]; };
struct tree_node { u32 mode, size, at, name, parent; u16 name_len, nlink; u32 same, mtime; };
_Static_assert(sizeof(struct tree_head) == 32 && sizeof(struct tree_node) == 32, "the tree's head and a node are 32 bytes");

struct tree {
  const struct tree_node *nodes;
  const u64 *slots;
  const u32 *owners;
  const u8 *names;
  u32 count, mask, shift, names_len;
};

/* The numbers Linux gives for what a walk comes to. */
enum { TREE_NOENT = 2, TREE_IO = 5, TREE_NOTDIR = 20, TREE_NAMETOOLONG = 36, TREE_LOOP = 40 };
enum { TREE_LINKS = 40, TREE_NAME = 255 };
#define TREE_IS(mode, kind) (((mode) & 0170000) == (kind))
enum { TREE_DIR = 0040000, TREE_LINK = 0120000 };

/* How many bytes a tree of so many nodes, slots and bytes of names is. */
static inline u64 tree_bytes(u64 nodes, u64 slots, u64 names) {
  return sizeof(struct tree_head) + nodes * 32 + slots * 8 + ((nodes * 4 + 7) & ~7ull) + names + SLACK;
}

/* `bytes` as a tree, or 0 where it is not one: its parts are where its head says, within `len`. */
static inline int tree_open(struct tree *t, const u8 *bytes, u64 len) {
  const struct tree_head *h = (const struct tree_head *)bytes;
  if (len < sizeof *h || ld64(h->magic) != ld64((const u8 *)"ricetree")) return 0;
  if (!h->nodes || h->slots <= h->nodes || (h->slots & (h->slots - 1)) || tree_bytes(h->nodes, h->slots, h->names) > len) return 0;
  t->nodes = (const struct tree_node *)(bytes + sizeof *h);
  t->slots = (const u64 *)(t->nodes + h->nodes);
  t->owners = (const u32 *)(t->slots + h->slots);
  t->names = (const u8 *)t->owners + ((h->nodes * 4ull + 7) & ~7ull);
  t->count = h->nodes, t->mask = h->slots - 1, t->shift = 64 - (u32)__builtin_ctz(h->slots), t->names_len = h->names;
  return 1;
}

/* A name's hash in its directory: begun with the directory, a word of the name stirred in at a time (the last one
 * its bytes alone). */
static inline u64 tree_begin(u32 dir) { return (dir + 1ull) * 0x9e3779b97f4a7c15ull; }
static inline u64 tree_stir(u64 h, u64 word) {
  h = (h ^ word) * 0xff51afd7ed558ccdull;
  return h ^ h >> 32;
}
/* Where a hash's slot is among so many (a power of two, at least two): its high bits, a product's best. */
static inline u32 tree_slot(u64 h, u32 slots) { return (u32)((h * 0x9e3779b97f4a7c15ull) >> (64 - __builtin_ctz(slots))); }
static inline u64 tree_hash(u32 dir, const u8 *name, u32 len) {
  u64 h = tree_begin(dir);
  for (; len >= 8; len -= 8, name += 8) h = tree_stir(h, ld64(name));
  return len ? tree_stir(h, ld64(name) & (~0ull >> (64 - 8 * len))) : h;
}

/* The entry `name` (len bytes, SLACK after them; `h` its hash) of the directory `dir`: its node, or -TREE_NOENT. */
static inline i64 tree_find(const struct tree *t, u32 dir, const u8 *name, u32 len, u64 h) {
  for (u32 i = (u32)((h * 0x9e3779b97f4a7c15ull) >> t->shift), left = t->mask;; i = (i + 1) & t->mask) {
    u64 s = t->slots[i];
    if (!s) return -TREE_NOENT;
    if ((u32)(s >> 32) == (u32)h) {
      u32 n = (u32)s - 1;
      if (n >= t->count) return -TREE_IO;
      const struct tree_node *c = &t->nodes[n];
      if (c->parent == dir && c->name_len == len && (u64)c->name + len <= t->names_len) {
        const u8 *is = t->names + c->name;
        /* (A name of up to eight bytes, most of them: one word of each, the bytes past it left out.) */
        if (len <= 8 ? !((ld64(is) ^ ld64(name)) << (64 - 8 * len)) : eq(is, name, len)) return n;
      }
    }
    if (!left--) return -TREE_NOENT; /* (a table with no empty slot is not one its maker wrote) */
  }
}
static inline i64 tree_child(const struct tree *t, u32 dir, const u8 *name, u32 len) {
  return tree_find(t, dir, name, len, tree_hash(dir, name, len));
}

/*
 * The node `path` (len bytes, SLACK after them) names, from the directory `from` (the root where it begins with a
 * slash), as Linux walks one: "." and "..", a link followed (its target from the root, or from the directory it is
 * in) unless it is the last name and `follow` is not set and no slash is after it, at most TREE_LINKS links in all;
 * a name with one after it, or a slash, is a directory. A node, or what Linux says: -TREE_NOENT, -TREE_NOTDIR,
 * -TREE_LOOP, -TREE_NAMETOOLONG.
 */
static inline i64 tree_walk(const struct tree *t, u32 from, const u8 *path, u64 len, int follow) {
  __attribute__((uninitialized)) struct { const u8 *p, *e; } after[TREE_LINKS]; /* what follows each link being followed */
  u32 depth = 0, links = 0, at = from;
  const u8 *p = path, *e = path + len;
  if (p == e) return -TREE_NOENT;
  if (*p == '/') at = 0;
  for (;;) {
    if (p < e && *p == '/') {
      do p++; while (p < e && *p == '/');
      if (!TREE_IS(t->nodes[at].mode, TREE_DIR)) return -TREE_NOTDIR;
    }
    if (p == e) {
      if (!depth) return at;
      depth--, p = after[depth].p, e = after[depth].e;
      continue;
    }
    if (!TREE_IS(t->nodes[at].mode, TREE_DIR)) return -TREE_NOTDIR;
    /* The name: its end found and its hash made in one reading of it, eight bytes at a time. */
    const u8 *name = p;
    u64 h = tree_begin(at);
    for (;;) {
      u64 w = ld64(p), slash = zeros(w ^ '/' * ONES), left = (u64)(e - p);
      u64 k = slash ? (u64)__builtin_ctzll(slash) >> 3 : 8;
      if (k > left) k = left;
      p += k;
      if (k < 8) {
        if (k) h = tree_stir(h, w & (~0ull >> (64 - 8 * k)));
        break;
      }
      h = tree_stir(h, w);
    }
    u32 n = (u32)(p - name);
    if (n == 1 && name[0] == '.') continue;
    if (n == 2 && name[0] == '.' && name[1] == '.') {
      at = t->nodes[at].parent < t->count ? t->nodes[at].parent : 0;
      continue;
    }
    if (n > TREE_NAME) return -TREE_NAMETOOLONG;
    i64 c = tree_find(t, at, name, n, h);
    if (c < 0) return c;
    const struct tree_node *node = &t->nodes[c];
    if (TREE_IS(node->mode, TREE_LINK) && (follow || depth || p < e)) {
      if (links++ == TREE_LINKS) return -TREE_LOOP;
      if ((u64)node->at + node->size > t->names_len) return -TREE_IO;
      after[depth].p = p, after[depth].e = e, depth++;
      p = t->names + node->at, e = p + node->size;
      if (p == e) return -TREE_NOENT;
      if (*p == '/') at = 0;
      continue;
    }
    at = (u32)c;
  }
}

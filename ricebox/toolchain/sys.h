/*
 * The kernel, as a program with no C library has it: its calls (as x86-64 Linux numbers them), what the compiler may
 * call (memset and the rest), the stack protector's guard, the clock, and the start: the second of lib's three
 * (word.h, then this, then io.h).
 *
 * A unit defines UNIT (its name, as its messages begin) before it takes this, and main_, which the start calls with
 * what the kernel gave it.
 */
#pragma once
#include "word.h"

#ifndef UNIT
#error "a unit names itself (#define UNIT) before it takes sys.h"
#endif

enum {
  SYS_read = 0, SYS_write = 1, SYS_open = 2, SYS_writev = 20, SYS_close = 3, SYS_fstat = 5, SYS_mmap = 9, SYS_pread = 17,
  SYS_dup2 = 33, SYS_fork = 57, SYS_pipe2 = 293,
  SYS_flock = 73, SYS_fsync = 74, SYS_getcwd = 79, SYS_getdents64 = 217, SYS_rename = 82, SYS_mkdir = 83,
  SYS_unlink = 87, SYS_clock_gettime = 228, SYS_exit_group = 231, SYS_newfstatat = 262,
  SYS_madvise = 28, SYS_clone = 56, SYS_exit = 60, SYS_futex = 202, SYS_sched_getaffinity = 204,
};
enum { O_RDONLY = 0, O_WRONLY = 1, O_RDWR = 2, O_CREAT = 0100, O_TRUNC = 01000, O_APPEND = 02000, O_NONBLOCK = 04000,
       O_CLOEXEC = 02000000 };
enum { LOCK_SH = 1, LOCK_EX = 2 };
enum { ENOENT = 2, EINTR = 4, EEXIST = 17, EINVAL = 22, ENOLCK = 37, ENOSYS = 38, EOPNOTSUPP = 95 };
#define AT_FDCWD (-100)

static inline i64 sys1(i64 n, i64 a) {
  i64 r;
  __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a) : "rcx", "r11", "memory");
  return r;
}
static inline i64 sys2(i64 n, i64 a, i64 b) {
  i64 r;
  __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b) : "rcx", "r11", "memory");
  return r;
}
static inline i64 sys3(i64 n, i64 a, i64 b, i64 c) {
  i64 r;
  __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c) : "rcx", "r11", "memory");
  return r;
}
static inline i64 sys4(i64 n, i64 a, i64 b, i64 c, i64 d) {
  i64 r;
  register i64 r10 __asm__("r10") = d;
  __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c), "r"(r10) : "rcx", "r11", "memory");
  return r;
}
static inline i64 sys6(i64 n, i64 a, i64 b, i64 c, i64 d, i64 e, i64 f) {
  i64 r;
  register i64 r10 __asm__("r10") = d;
  register i64 r8 __asm__("r8") = e;
  register i64 r9 __asm__("r9") = f;
  __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c), "r"(r10), "r"(r8), "r"(r9) : "rcx", "r11", "memory");
  return r;
}

__attribute__((noreturn)) static void leave(int code) {
  for (;;) sys1(SYS_exit_group, code);
}

/* ---- Threads: another flow of this process on a stack of its own, all else shared (as a C library's pthread_create,
 * with none): run(arg) is called on the stack's top, and *left, the thread's id until it ends, is cleared then and
 * woken (CLONE_CHILD_CLEARTID), which join waits for. What it may not do is what is not shared safely: lib's output
 * (io.h put), and anything kept in a global; the arena it may take from (grab). */
#define CLONE_THREAD_FLAGS (0x100 | 0x200 | 0x400 | 0x800 | 0x10000 | 0x40000 | 0x100000 | 0x200000)
static inline i64 spawn(void (*run)(void *), void *arg, u8 *stack, u64 size, int *left) {
  u64 *top = (u64 *)((u64)(stack + size) & ~15ul);
  *--top = (u64)arg, *--top = (u64)run; /* (taken off it by the new thread: then the stack is as a call leaves it) */
  i64 r;
  register i64 r10 __asm__("r10") = (i64)left;
  register i64 r8 __asm__("r8") = 0;
  __asm__ volatile(
      "syscall\n\t"
      "test %%rax, %%rax\n\t"
      "jnz 1f\n\t"
      "pop %%rax\n\t"
      "pop %%rdi\n\t"
      "call *%%rax\n\t"
      "mov $60, %%eax\n\t" /* exit: this thread only */
      "xor %%edi, %%edi\n\t"
      "syscall\n\t"
      "ud2\n"
      "1:"
      : "=a"(r)
      : "a"(SYS_clone), "D"(CLONE_THREAD_FLAGS), "S"(top), "d"(left), "r"(r10), "r"(r8)
      : "rcx", "r11", "memory");
  return r;
}
static inline void join(int *left) {
  for (int v; (v = __atomic_load_n(left, __ATOMIC_ACQUIRE));) sys4(SYS_futex, (i64)left, 0 /* FUTEX_WAIT */, v, 0);
}
/* How many cores this process may run on (its affinity), one when the kernel will not say. */
static inline u32 cores(void) {
  u64 mask[16] = {0};
  i64 n = sys3(SYS_sched_getaffinity, 0, sizeof mask, (i64)mask);
  u32 c = 0;
  for (i64 i = 0; i < n / 8; i++)
    for (u64 m = mask[i]; m; m &= m - 1) c++; /* (no popcount: the baseline x86-64 has none, and libgcc's is not here) */
  return c ? c : 1;
}

/* struct stat as x86-64 Linux lays it out. */
struct kstat { u64 dev, ino, nlink; u32 mode, uid, gid, pad; u64 rdev; i64 size, blksize, blocks, times[6], unused[3]; };
_Static_assert(sizeof(struct kstat) == 144, "struct stat is 144 bytes on x86-64 Linux");
#define IS_DIR(m) (((m) & 0170000) == 0040000)
#define IS_REG(m) (((m) & 0170000) == 0100000)

/* ---- What the compiler may call (a copy or a clearing it makes of a struct or a loop): no C library has them. Eight
 * bytes at a time; built without loops turned back into calls to themselves (-fno-tree-loop-distribute-patterns). */

/* Words, the last one laid over the one before it where n is not a multiple of eight: never a byte past either end,
 * and no loop of bytes (a copy of under eight, two words of four, or of under four, three bytes, laid over each other). */
void *memset(void *d, int c, u64 n) {
  u8 *p = d;
  u64 w = (u8)c * ONES;
  if (n >= 8) {
    for (u64 i = 0; i + 8 < n; i += 8) st64(p + i, w);
    st64(p + n - 8, w);
  } else if (n >= 4) {
    st32(p, (u32)w), st32(p + n - 4, (u32)w);
  } else if (n) {
    p[0] = p[n / 2] = p[n - 1] = (u8)c;
  }
  return d;
}
void *memcpy(void *d, const void *s, u64 n) {
  u8 *p = d;
  const u8 *q = s;
  if (n >= 8) {
    u64 last = ld64(q + n - 8); /* (read first: memmove copies forward through this) */
    for (u64 i = 0; i + 8 < n; i += 8) st64(p + i, ld64(q + i));
    st64(p + n - 8, last);
  } else if (n >= 4) {
    u32 a = ld32(q), b = ld32(q + n - 4);
    st32(p, a), st32(p + n - 4, b);
  } else if (n) {
    u8 a = q[0], b = q[n / 2], c = q[n - 1];
    p[0] = a, p[n / 2] = b, p[n - 1] = c;
  }
  return d;
}
void *memmove(void *d, const void *s, u64 n) {
  u8 *p = d;
  const u8 *q = s;
  if (p <= q || p >= q + n) return memcpy(d, s, n);
  while (n--) p[n] = q[n];
  return d;
}
int memcmp(const void *a, const void *b, u64 n) {
  const u8 *p = a, *q = b;
  for (; n; n--, p++, q++) if (*p != *q) return *p - *q;
  return 0;
}

/* The stack protector's guard, a word of its own (-mstack-protector-guard=global: not one in thread-local storage,
 * which would take a call to set up, and which a program with no C library has none of), set from the kernel's random
 * bytes before anything it guards runs; and what a smashed stack comes to. */
__attribute__((visibility("hidden"))) u64 __stack_chk_guard;
__attribute__((noreturn, cold)) void __stack_chk_fail(void) {
  static const char m[] = UNIT ": stack smashed\n";
  sys3(SYS_write, 2, (i64)m, sizeof m - 1);
  leave(127);
}

/* ---- The time, in seconds since 1970: the kernel's own clock_gettime, in the vDSO it maps into a process
 * (AT_SYSINFO_EHDR), with no call into it. Found by name among the vDSO's symbols (its DT_HASH says how many); where
 * there is none (muk's processes), the call. */

static const u8 *vdso_at;
static inline u32 clock_s(void) {
  __attribute__((uninitialized)) struct { i64 s, ns; } ts;
  const u8 *b = vdso_at;
  if (b && ld32(b) == 0x464c457fu) { /* \x7fELF */
    u64 phoff = ld64(b + 32), dynv = 0;
    u16 phent = ld16(b + 54), phnum = ld16(b + 56);
    i64 bias = 0;
    int loaded = 0;
    for (u16 i = 0; i < phnum; i++) {
      const u8 *ph = b + phoff + (u64)i * phent;
      u32 type = ld32(ph);
      if (type == 1 && !loaded) bias = (i64)(b + ld64(ph + 8)) - (i64)ld64(ph + 16), loaded = 1; /* PT_LOAD */
      else if (type == 2) dynv = ld64(ph + 16); /* PT_DYNAMIC */
    }
    const u8 *strtab = 0, *symtab = 0, *hashtab = 0;
    for (const u8 *d = loaded && dynv ? (const u8 *)(dynv + (u64)bias) : 0; d && ld64(d); d += 16) {
      u64 tag = ld64(d), at = ld64(d + 8) + (u64)bias;
      if (tag == 5) strtab = (const u8 *)at;
      else if (tag == 6) symtab = (const u8 *)at;
      else if (tag == 4) hashtab = (const u8 *)at;
    }
    for (u32 i = 0, n = strtab && symtab && hashtab ? ld32(hashtab + 4) : 0; i < n; i++) {
      const u8 *sym = symtab + (u64)i * 24;
      if ((sym[4] & 0xf) != 2 || !ld16(sym + 6)) continue; /* a function, defined */
      if (same((const char *)strtab + ld32(sym), "__vdso_clock_gettime")) {
        i64 (*gettime)(i64, void *) = (i64 (*)(i64, void *))(ld64(sym + 8) + (u64)bias);
        if (!gettime(0, &ts)) return (u32)ts.s;
        break;
      }
    }
  }
  sys2(SYS_clock_gettime, 0, (i64)&ts);
  return (u32)ts.s;
}

/* ---- Where the kernel starts it: the stack it was given (argc, argv, envp, the auxiliary vector), the guard set
 * from AT_RANDOM, then the unit's main_. */

static int main_(int argc, char **argv, char **envp);
__attribute__((noreturn, used, no_stack_protector)) void start(u64 *sp) {
  int argc = (int)sp[0];
  char **argv = (char **)(sp + 1), **envp = argv + argc + 1;
  u64 *aux = (u64 *)envp;
  while (*aux++) {}
  for (; aux[0]; aux += 2) {
    if (aux[0] == 25) __stack_chk_guard = ld64((const u8 *)aux[1]) & ~0xffull; /* AT_RANDOM; a zero byte first, as libcs do */
    else if (aux[0] == 33) vdso_at = (const u8 *)aux[1]; /* AT_SYSINFO_EHDR */
  }
  leave(main_(argc, argv, envp));
}

__asm__(
  ".text\n"
  ".global _start\n"
  ".type _start, @function\n"
  "_start:\n"
  "  xor %ebp, %ebp\n"
  "  mov %rsp, %rdi\n"
  "  and $-16, %rsp\n"
  "  call start\n"
  "  hlt\n");

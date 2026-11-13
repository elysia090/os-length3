// movs and stos each way, alone and repeated, at every width: what the bytes are after and where rsi, rdi and rcx
// went. A repeated copy onto what it has still to read is done as the processor does it, an element at a time
// (going up with the destination ahead of the source, going down with it behind: what was copied is read again),
// and a repeat of none touches nothing. The direction flag is the thread's own: kept across a jump, round a loop,
// across a call and its return, through pushfq and popfq, clear in a signal's handler and as it was after it.
#define _GNU_SOURCE
#include <signal.h>
#include <stdint.h>
#include <stdio.h>

static unsigned char buf[96];
static void fresh(void) {
  for (int k = 0; k < 95; k++) buf[k] = (unsigned char)('A' + k % 26);
  buf[95] = 0;
}

// `insn` run with rsi and rdi at buf + src and buf + dst and rcx the count, after `way` (which sets DF), then cld:
// the bytes after, and how far each register went.
#define COPY_AS(what, way, insn, src, dst, count)                                                 \
  do {                                                                                            \
    fresh();                                                                                      \
    unsigned char *s = buf + (src), *d = buf + (dst);                                             \
    long c = (count);                                                                             \
    __asm__ volatile(way "\n\t" insn "\n\tcld" : "+S"(s), "+D"(d), "+c"(c) : : "cc", "memory");   \
    printf("%-22s %2d to %2d x%d: %.44s rsi%+ld rdi%+ld rcx=%ld\n", what, src, dst, count, buf,   \
           (long)(s - buf) - (src), (long)(d - buf) - (dst), c);                                  \
  } while (0)
#define COPY(way, insn, src, dst, count) COPY_AS(way " " insn, way, insn, src, dst, count)
#define FILL(way, insn, dst, count)                                                               \
  do {                                                                                            \
    fresh();                                                                                      \
    unsigned char *d = buf + (dst);                                                               \
    long c = (count);                                                                             \
    __asm__ volatile(way "\n\t" insn "\n\tcld" : "+D"(d), "+c"(c) : "a"(0x3837363534333231ULL) : "cc", "memory"); \
    printf("%-22s at %2d x%d: %.44s rdi%+ld rcx=%ld\n", way " " insn, dst, count, buf, (long)(d - buf) - (dst), c); \
  } while (0)

// Every copy of one width: apart, onto itself safely, onto what is still to be read, by less than an element, none.
#define COPIES(insn, n)                                                                           \
  COPY("cld", "rep " insn, 0, 24, 3);          /* apart */                                        \
  COPY("cld", "rep " insn, 8, 8 - (n), 3);     /* the destination behind: what is read was not yet written */ \
  COPY("cld", "rep " insn, 0, (n), 5);         /* ahead by one element: the first element again and again */ \
  COPY("cld", "rep " insn, 0, 2 * (n), 5);     /* ahead by two */                                 \
  COPY("cld", "rep " insn, 0, 1, 5);           /* ahead by a byte: within an element at the wider widths */ \
  COPY("cld", "rep " insn, 4, 4, 3);           /* onto itself */                                  \
  COPY("cld", "rep " insn, 0, 24, 0);          /* none */                                         \
  COPY("std", "rep " insn, 16, 40, 3);         /* down, apart */                                  \
  COPY("std", "rep " insn, 16, 16 + (n), 3);   /* down, the destination ahead: safe */            \
  COPY("std", "rep " insn, 24, 24 - (n), 5);   /* down, behind by one element: the last element again and again */ \
  COPY("std", "rep " insn, 24, 24 - 2 * (n), 5);                                                  \
  COPY("std", "rep " insn, 24, 23, 5);         /* down, behind by a byte */                       \
  COPY("std", "rep " insn, 16, 16, 3);                                                            \
  COPY("std", "rep " insn, 16, 40, 0);                                                            \
  COPY("cld", insn, 0, 24, 7);                 /* one element: rcx is not its count */            \
  COPY("std", insn, 8, 24, 7);                                                                    \
  COPY("cld", insn, 0, 1, 7);                                                                     \
  COPY("std", insn, 8, 7, 7)
#define FILLS(insn, n)                                                                            \
  FILL("cld", "rep " insn, 4, 3);                                                                 \
  FILL("std", "rep " insn, 24, 3);                                                                \
  FILL("cld", "rep " insn, 4, 0);                                                                 \
  FILL("std", "rep " insn, 24, 0);                                                                \
  FILL("cld", insn, 4, 7);                                                                        \
  FILL("std", insn, 24, 7)

static volatile int met = -1;
static unsigned char copied[4];
// A handler: DF as it finds it, and a copy as its own code makes one (a compiler's, which takes DF to be clear).
static void handler(int sig) {
  (void)sig;
  unsigned long f;
  __asm__ volatile("leaq -128(%%rsp), %%rsp\n\tpushfq\n\tpopq %[f]\n\tleaq 128(%%rsp), %%rsp" : [f] "=&r"(f) : : "memory");
  met = (int)(f >> 10 & 1);
  const unsigned char *s = (const unsigned char *)"abc";
  unsigned char *d = copied;
  long c = 3;
  __asm__ volatile("rep movsb" : "+S"(s), "+D"(d), "+c"(c) : : "memory");
}

int main(void) {
  COPIES("movsb", 1);
  COPIES("movsw", 2);
  COPIES("movsl", 4);
  COPIES("movsq", 8);
  FILLS("stosb", 1);
  FILLS("stosw", 2);
  FILLS("stosl", 4);
  FILLS("stosq", 8);

  // DF set, and the copy in the code a jump leads to.
  COPY_AS("std, a jump", "std\n\tjmp 1f\n1:", "rep movsb", 6, 7, 7);
  COPY_AS("cld, a jump", "cld\n\tjmp 1f\n1:", "rep movsb", 0, 1, 7);
  // Round a loop: each time round finds DF as the time before left it.
  COPY_AS("std, a loop", "std", "1:\tmovsb\n\tdecq %%rcx\n\tjnz 1b", 6, 7, 7);
  COPY_AS("cld, a loop", "cld", "1:\tmovsb\n\tdecq %%rcx\n\tjnz 1b", 0, 1, 7);
  // Across a call and its return (the stack moved clear of what the compiler keeps under rsp).
  COPY_AS("std, a call", "std\n\tleaq -128(%%rsp), %%rsp\n\tcall 2f\n\tjmp 3f\n2:\tret\n3:\tleaq 128(%%rsp), %%rsp", "rep movsb", 6, 7, 7);
  // Set in the code called, and still set after its return.
  COPY_AS("std in what is called", "leaq -128(%%rsp), %%rsp\n\tcall 2f\n\tjmp 3f\n2:\tstd\n\tret\n3:\tleaq 128(%%rsp), %%rsp", "rep movsb", 6, 7, 7);
  // Pushed set, cleared, popped: set again. Pushed clear, set, popped: clear again.
  COPY_AS("std pushed, popped", "std\n\tleaq -128(%%rsp), %%rsp\n\tpushfq\n\tcld\n\tpopfq\n\tleaq 128(%%rsp), %%rsp", "rep movsb", 6, 7, 7);
  COPY_AS("cld pushed, popped", "cld\n\tleaq -128(%%rsp), %%rsp\n\tpushfq\n\tstd\n\tpopfq\n\tleaq 128(%%rsp), %%rsp", "rep movsb", 0, 1, 7);
  // The flags pushed say it.
  unsigned long set, clear;
  __asm__ volatile("std\n\tleaq -128(%%rsp), %%rsp\n\tpushfq\n\tpopq %[a]\n\tcld\n\tpushfq\n\tpopq %[b]\n\tleaq 128(%%rsp), %%rsp"
                   : [a] "=&r"(set), [b] "=&r"(clear) : : "cc", "memory");
  printf("DF as pushed: %lu after std, %lu after cld\n", set >> 10 & 1, clear >> 10 & 1);

  // A signal taken while DF is set (kill to itself, by the calls themselves): its handler finds DF clear, and what it
  // came back to has DF set as before.
  signal(SIGUSR1, handler);
  unsigned long after;
  __asm__ volatile("std\n\tmovl $39, %%eax\n\tsyscall\n\tmovl %%eax, %%edi\n\tmovl $10, %%esi\n\tmovl $62, %%eax\n\tsyscall\n\t"
                   "leaq -128(%%rsp), %%rsp\n\tpushfq\n\tpopq %[f]\n\tleaq 128(%%rsp), %%rsp\n\tcld"
                   : [f] "=&r"(after) : : "rax", "rcx", "rdx", "rsi", "rdi", "r11", "cc", "memory");
  printf("a signal while DF was set: its handler met DF %s and copied %.3s; DF after it was %s\n",
         met == 0 ? "clear" : met == 1 ? "set" : "not at all", copied, after >> 10 & 1 ? "set" : "clear");
  return 0;
}

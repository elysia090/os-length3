/* Flags that cross a function's edge, as post-linked code has them: one
 * body for states whose futures are equal, so a compare can end one
 * function and the jump that reads it begin another. A system call between
 * them keeps the flags. */
#include <stdio.h>

int cmp_then(unsigned long a, unsigned long b);
int cmp_sys(unsigned long a, unsigned long b);
int take(void);

__asm__(
    ".text\n"
    ".globl cmp_then\n.type cmp_then,@function\n"
    "cmp_then:\n"
    "  cmp %rsi, %rdi\n"
    /* Falls into another function's head, which reads the flags first. */
    ".globl take\n.type take,@function\n"
    "take:\n"
    "  ja 1f\n"
    "  jb 2f\n"
    "  mov $0, %eax\n"
    "  ret\n"
    "1: mov $1, %eax\n"
    "  ret\n"
    "2: mov $-1, %eax\n"
    "  ret\n"
    ".globl cmp_sys\n.type cmp_sys,@function\n"
    "cmp_sys:\n"
    "  cmp %rsi, %rdi\n"
    "  mov $39, %eax\n" /* getpid */
    "  syscall\n"
    "  jmp take\n");

int main(void) {
  unsigned long v[] = {0, 1, 2, 0x7fffffffffffffffUL, 0x8000000000000000UL, ~0UL};
  int n = sizeof v / sizeof *v, sum = 0;
  for (int i = 0; i < n; i++)
    for (int j = 0; j < n; j++) {
      int a = cmp_then(v[i], v[j]), b = cmp_sys(v[i], v[j]);
      printf("%d%d ", a, b);
      sum += (a * 3 + b) * (i * n + j + 1);
    }
  printf("\n%d\n", sum);
  return 0;
}

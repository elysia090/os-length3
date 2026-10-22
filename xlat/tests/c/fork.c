// What a child sees after fork: everything the parent changed, wherever it
// lives (initialized data, bss, stack, heap, a mapping), and nothing it did
// after. Then the same again two levels down.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

static int data = 5;
static char bss[1 << 20];

static void show(const char *who, const char *stack, const char *heap, const char *map) {
  printf("%s data=%d bss=%d stack=%s heap=%s map=%s\n", who, data, bss[12345], stack, heap, map);
}

int main(void) {
  char stack[32];
  char *heap = malloc(64), *map = mmap(0, 1 << 16, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  data = 7; bss[12345] = 9;
  strcpy(stack, "s1"); strcpy(heap, "h1"); strcpy(map, "m1");
  pid_t p = fork();
  if (p == 0) {
    show("child", stack, heap, map);
    data = 8; strcpy(heap, "h2");
    pid_t q = fork();
    if (q == 0) { show("grandchild", stack, heap, map); return 3; }
    int st; waitpid(q, &st, 0);
    printf("grandchild exit %d\n", WEXITSTATUS(st));
    return 2;
  }
  int st; waitpid(p, &st, 0);
  printf("child exit %d\n", WEXITSTATUS(st));
  show("parent", stack, heap, map);
  return 0;
}

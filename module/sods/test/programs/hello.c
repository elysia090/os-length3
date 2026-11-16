#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
    const char *name = strrchr(argv[0], '/');
    printf("hello from %s with %d args\n", name ? name + 1 : argv[0], argc);
    return 3;
}

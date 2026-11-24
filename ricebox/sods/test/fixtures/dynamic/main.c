/* A normal dynamically linked PIE. The dynamic loader must run the DSO's
 * constructor before the executable can print the result. */
#include <stdio.h>
#include <string.h>

extern int fixture_value(void);

int main(int argc, char **argv) {
    if (argc != 2 || strcmp(argv[1], "check") != 0) return 20;
    if (fixture_value() != 42) return 21;
    puts("dynamic-pie:42");
    return 0;
}

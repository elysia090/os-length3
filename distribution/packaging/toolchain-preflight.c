#define FIRST 6
#define SECOND 7
#if FIRST * SECOND != 42
#error incorrect preprocessing
#endif
#define DECLARE(name, value) int name(void) { return (value); }
DECLARE(answer, FIRST * SECOND)

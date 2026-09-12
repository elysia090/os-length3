#include <execinfo.h>

__attribute__((noinline))
static int capture_stack(void)
{
    void *frames[16];
    return backtrace(frames, 16) >= 4 ? 0 : 1;
}

__attribute__((noinline))
static int call_capture(void)
{
    return capture_stack();
}

int main(void)
{
    return call_capture();
}

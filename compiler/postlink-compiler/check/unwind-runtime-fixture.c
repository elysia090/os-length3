#include <stdint.h>
#include <unwind.h>

static int capture_stack(void);
static int call_capture(void);
int main(void);

typedef struct { unsigned count, observed; } trace;

static _Unwind_Reason_Code visit_frame(struct _Unwind_Context *context, void *argument)
{
    trace *state = argument;
    uintptr_t region = (uintptr_t)_Unwind_GetRegionStart(context);
    if (_Unwind_GetIP(context)) ++state->count;
    if (region == (uintptr_t)capture_stack) state->observed |= 1u;
    if (region == (uintptr_t)call_capture) state->observed |= 2u;
    if (region == (uintptr_t)main) state->observed |= 4u;
    return state->count == 16u ? _URC_END_OF_STACK : _URC_NO_REASON;
}

__attribute__((noinline))
static int capture_stack(void)
{
    /* Test the compiler's unwind tables directly, independently of whether
     * libc supplies the nonstandard execinfo.h convenience interface. */
    trace state = { 0u, 0u };
    _Unwind_Reason_Code result = _Unwind_Backtrace(visit_frame, &state);
    return result == _URC_END_OF_STACK && state.count >= 4u
        && state.observed == 7u ? 0 : 1;
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

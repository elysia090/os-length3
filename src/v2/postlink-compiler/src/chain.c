/* Static successors and their block ranks.  See include/postlink/chain.h. */

#include <postlink/chain.h>

int pl_control_is_static_dispatch(pl_u32 control)
{
    switch (control) {
    /* The successor is a runtime value, not a constant. */
    case PL_CONTROL_DYNAMIC:
    case PL_CONTROL_HALT:
    case PL_CONTROL_FAR_RETURN:
    case PL_CONTROL_INTERRUPT_RETURN:
    case PL_CONTROL_EXCEPTION:
    case PL_CONTROL_SYSCALL:
    case PL_CONTROL_SYSRET:
        return 0;
    default:
        return 1;
    }
}

static void append(pl_successors *out, pl_u64 rip)
{
    for (pl_u32 index = 0; index < out->count; ++index)
        if (out->rip[index] == rip) return;   /* deduplicated, as written */
    if (out->count < PL_MAX_SUCCESSORS) out->rip[out->count++] = rip;
}

void pl_static_successors(const pl_admission *admission, pl_successors *out)
{
    out->count = 0;
    pl_u32 control = admission->continuation.control;
    const pl_u64 *field = admission->continuation.field;

    if (!pl_control_is_static_dispatch(control)) return;

    if (control == PL_CONTROL_CONDITIONAL) {
        /* Both arms are targets even when one of them is zero: a conditional
         * always names two continuations. */
        append(out, field[PL_FIELD_FIRST]);
        append(out, field[PL_FIELD_SECOND]);
        return;
    }
    if (control == PL_CONTROL_BRANCH) {
        if (field[PL_FIELD_FIRST]) append(out, field[PL_FIELD_FIRST]);
        if (field[PL_FIELD_SECOND]) append(out, field[PL_FIELD_SECOND]);
        return;
    }
    if (control == PL_CONTROL_NEXT || control == PL_CONTROL_TIMESLICE) {
        append(out, field[PL_FIELD_BOUNDARY]);
        return;
    }
    append(out, field[PL_FIELD_FIRST]);
}

int pl_chain_resolve(const pl_directory *directory, pl_u64 rip,
                     pl_chain_target *out)
{
    pl_u32 index = 0;
    pl_u32 variants = 0;
    int status = pl_directory_find(directory, rip, &index, &variants);
    if (status) return status;
    out->index = index;
    out->variants = variants;
    return 0;
}

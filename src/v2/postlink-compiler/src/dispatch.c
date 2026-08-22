/* Exact residual-state partition.  See include/postlink/dispatch.h. */

#include <postlink/dispatch.h>

static int target_equal(const pl_dispatch_target *left,
                        const pl_dispatch_target *right)
{
    return left->kind == right->kind
        && left->class_rank == right->class_rank
        && left->variants == right->variants
        && left->coordinate == right->coordinate;
}

static int target_after(const pl_dispatch_target *left,
                        const pl_dispatch_target *right)
{
    if (left->kind != right->kind) return left->kind > right->kind;
    if (left->class_rank != right->class_rank)
        return left->class_rank > right->class_rank;
    if (left->variants != right->variants)
        return left->variants > right->variants;
    return left->coordinate > right->coordinate;
}

static int describe_target(const pl_directory *directory, pl_u64 coordinate,
                           const pl_u32 *prior_class,
                           pl_dispatch_target *out,
                           pl_dispatch_report *report)
{
    out->kind = PL_DISPATCH_TARGET_NONE;
    out->class_rank = 0;
    out->variants = 0;
    out->coordinate = 0;
    pl_chain_target target;
    int status = pl_chain_resolve(directory, coordinate, &target);
    if (status == PL_ERROR_ABSENT) {
        out->kind = PL_DISPATCH_TARGET_ABSENT;
        out->coordinate = coordinate;
        if (report) report->absent_targets += 1u;
        return 0;
    }
    if (status) return status;
    if (target.variants != 1u) {
        out->kind = PL_DISPATCH_TARGET_VARIANTS;
        out->variants = target.variants;
        out->coordinate = coordinate;
        if (report) report->variant_targets += 1u;
        return 0;
    }
    out->kind = PL_DISPATCH_TARGET_CLASS;
    out->class_rank = prior_class ? prior_class[target.index] : 0u;
    return 0;
}

static void clear_signature(pl_dispatch_signature *out)
{
    out->step_rank = 0;
    out->control = 0;
    for (pl_u32 index = 0; index < 3u; ++index) out->payload[index] = 0;
    for (pl_u32 index = 0; index < PL_MAX_SUCCESSORS; ++index) {
        out->successor[index].kind = PL_DISPATCH_TARGET_NONE;
        out->successor[index].class_rank = 0;
        out->successor[index].variants = 0;
        out->successor[index].coordinate = 0;
    }
}

int pl_dispatch_describe(const pl_directory *directory, pl_u32 index,
                         const pl_u32 *prior_class,
                         pl_dispatch_signature *out,
                         pl_dispatch_report *report)
{
    if (!directory || !out || index >= directory->counts.block_count)
        return PL_ERROR_DIRECTORY;
    pl_block_instance instance;
    pl_admission admission;
    int status = pl_directory_block(directory, index, &instance);
    if (status) return status;
    status = pl_directory_admit(directory, index, &admission);
    if (status) return status;

    clear_signature(out);
    out->step_rank = instance.step_rank;
    out->control = admission.continuation.control;
    out->payload[0] = admission.continuation.field[PL_FIELD_FIRST];
    out->payload[1] = admission.continuation.field[PL_FIELD_SECOND];
    out->payload[2] = admission.continuation.field[PL_FIELD_THIRD];

    if (out->control == PL_CONTROL_NEXT) {
        out->control = PL_DISPATCH_GOTO;
        out->payload[0] = 0;
        out->payload[1] = 0;
        out->payload[2] = 0;
        return describe_target(
            directory, admission.continuation.field[PL_FIELD_BOUNDARY],
            prior_class, &out->successor[0], report);
    }
    if (out->control == PL_CONTROL_TIMESLICE) {
        out->payload[0] = 0;
        out->payload[1] = 0;
        out->payload[2] = 0;
        return describe_target(
            directory, admission.continuation.field[PL_FIELD_BOUNDARY],
            prior_class, &out->successor[0], report);
    }
    if (out->control == PL_CONTROL_BRANCH) {
        out->payload[0] = 0;
        out->payload[1] = 0;
        out->payload[2] = 0;
        status = describe_target(
            directory, admission.continuation.field[PL_FIELD_FIRST],
            prior_class, &out->successor[0], report);
        if (status) return status;
        /* A return coordinate carried for closure discovery is not consumed
         * by branch execution.  The closure graph retains that edge; the
         * residual signature does not confuse it with an observation. */
        out->control = PL_DISPATCH_GOTO;
        return 0;
    }
    if (out->control == PL_CONTROL_CONDITIONAL) {
        if (report) report->conditionals += 1u;
        out->payload[0] = 0;
        out->payload[1] = 0;
        out->payload[2] &= 15u;
        status = describe_target(
            directory, admission.continuation.field[PL_FIELD_FIRST],
            prior_class, &out->successor[0], report);
        if (status) return status;
        status = describe_target(
            directory, admission.continuation.field[PL_FIELD_SECOND],
            prior_class, &out->successor[1], report);
        if (status) return status;
        if (target_equal(&out->successor[0], &out->successor[1])) {
            out->control = PL_DISPATCH_GOTO;
            out->payload[2] = 0;
            out->successor[1].kind = PL_DISPATCH_TARGET_NONE;
            if (report) report->collapsed_conditionals += 1u;
        } else if (target_after(
                       &out->successor[0], &out->successor[1])) {
            pl_dispatch_target temporary = out->successor[0];
            out->successor[0] = out->successor[1];
            out->successor[1] = temporary;
            out->payload[2] ^= 1u;
            if (report) report->complemented_conditionals += 1u;
        }
        return 0;
    }
    if (out->control == PL_CONTROL_DYNAMIC) {
        /* Only the first field, a local index, selects the runtime target. */
        out->payload[1] = 0;
        out->payload[2] = 0;
        return 0;
    }
    if (pl_control_is_static_dispatch(out->control)) {
        out->payload[0] = 0;
        return describe_target(
            directory, admission.continuation.field[PL_FIELD_FIRST],
            prior_class, &out->successor[0], report);
    }
    return 0;
}

int pl_dispatch_signature_equal(const pl_dispatch_signature *left,
                                const pl_dispatch_signature *right)
{
    if (left->step_rank != right->step_rank
            || left->control != right->control)
        return 0;
    for (pl_u32 index = 0; index < 3u; ++index)
        if (left->payload[index] != right->payload[index]) return 0;
    for (pl_u32 index = 0; index < PL_MAX_SUCCESSORS; ++index)
        if (!target_equal(&left->successor[index],
                          &right->successor[index]))
            return 0;
    return 1;
}

static pl_u64 mix(pl_u64 hash, pl_u64 value)
{
    hash ^= value + 0x9e3779b97f4a7c15ull + (hash << 6u) + (hash >> 2u);
    return hash;
}

static pl_u64 signature_hash(const pl_dispatch_signature *row)
{
    pl_u64 hash = 0xcbf29ce484222325ull;
    hash = mix(hash, row->step_rank);
    hash = mix(hash, row->control);
    for (pl_u32 index = 0; index < 3u; ++index)
        hash = mix(hash, row->payload[index]);
    for (pl_u32 index = 0; index < PL_MAX_SUCCESSORS; ++index) {
        hash = mix(hash, row->successor[index].kind);
        hash = mix(hash, row->successor[index].class_rank);
        hash = mix(hash, row->successor[index].variants);
        hash = mix(hash, row->successor[index].coordinate);
    }
    return hash;
}

int pl_dispatch_refine(const pl_directory *directory,
                       const pl_u32 *prior_class, pl_u32 *next_class,
                       pl_dispatch_signature *signature,
                       pl_u32 *table, pl_u32 table_slots,
                       pl_dispatch_report *report)
{
    if (!directory || !next_class || !signature || !table || !table_slots
            || (table_slots & (table_slots - 1u))
            || table_slots / 2u < directory->counts.block_count)
        return PL_ERROR_DIRECTORY;
    for (pl_u32 slot = 0; slot < table_slots; ++slot) table[slot] = 0;
    pl_dispatch_report local = { 0, 0, 0, 0, 0, 0, 0 };
    pl_u32 classes = 0;
    for (pl_u32 index = 0; index < directory->counts.block_count; ++index) {
        int status = pl_dispatch_describe(
            directory, index, prior_class, &signature[index], &local);
        if (status) return status;
        pl_u32 first = (pl_u32)signature_hash(&signature[index])
                     & (table_slots - 1u);
        pl_u32 probe;
        for (probe = 0; probe < table_slots; ++probe) {
            pl_u32 slot = (first + probe) & (table_slots - 1u);
            pl_u32 held = table[slot];
            if (!held) {
                table[slot] = index + 1u;
                classes += 1u;
                next_class[index] = classes;
                break;
            }
            if (pl_dispatch_signature_equal(
                    &signature[index], &signature[held - 1u])) {
                next_class[index] = next_class[held - 1u];
                break;
            }
        }
        if (probe == table_slots) return PL_ERROR_DIRECTORY;
        if (probe > local.maximum_probe) local.maximum_probe = probe;
    }
    local.classes = classes;
    if (report) *report = local;
    return 0;
}

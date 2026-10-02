#include "../src/internal/x86-selection.h"

#include <stdio.h>
#include <string.h>

#define SELECT_OUTPUT_CAPACITY 256u

#if defined(__x86_64__) && defined(__GNUC__)
static pl_u64 and32_mask_flags(pl_u32 value, pl_u32 mask)
{
    pl_u64 flags = 0u;
    __asm__ volatile(
        "movl %1, %%esi\n\t"
        "andl %2, %%esi\n\t"
        "movq %%rsp, %%rsi\n\t"
        "pushfq\n\tpopq %0"
        : "=r"(flags) : "r"(value), "r"(mask)
        : "rsi", "cc", "memory");
    return flags;
}

static pl_u64 test8_mask_flags(pl_u32 value, pl_u32 mask)
{
    pl_u64 flags = 0u;
    __asm__ volatile(
        "movl %1, %%esi\n\t"
        "testb %b2, %%sil\n\t"
        "movq %%rsp, %%rsi\n\t"
        "pushfq\n\tpopq %0"
        : "=r"(flags) : "r"(value), "r"(mask)
        : "rsi", "cc", "memory");
    return flags;
}

static pl_u64 test16_mask_flags(pl_u32 value, pl_u32 mask)
{
    pl_u64 flags = 0u;
    __asm__ volatile(
        "movl %1, %%esi\n\t"
        "testw %w2, %%si\n\t"
        "movq %%rsp, %%rsi\n\t"
        "pushfq\n\tpopq %0"
        : "=r"(flags) : "r"(value), "r"(mask)
        : "rsi", "cc", "memory");
    return flags;
}
#endif

static int select_with_fields(const pl_u8 *bytes, pl_u32 count,
                              pl_u64 start, int construction_fields,
                              int relax_short_control,
                              pl_x86_native_selection *selection,
                              pl_u8 output[SELECT_OUTPUT_CAPACITY],
                              pl_u32 *written)
{
    pl_x86_map map = {
        bytes, 0x1000u, count, count,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image image = { &map, 1u, 0u, start };
    pl_x86_frontend frontend;
    static pl_u8 first[1024u * 1024u];
    static pl_u8 second[1024u * 1024u];
    static pl_u8 select_first[1024u * 1024u];
    static pl_u8 select_second[1024u * 1024u];
    pl_x86_block_workspace workspace = {
        first, second, sizeof first, 128u,
    };
    pl_x86_block_workspace selection_workspace = {
        select_first, select_second, sizeof select_first, 128u,
    };
    pl_x86_block block;
    int status = pl_x86_frontend_open(&image, &frontend);
    if (!status)
        status = pl_x86_block_lower(
            &frontend, image.entry, &workspace, &block);
    if (!status) block.construction_fields = construction_fields != 0;
    if (!status) block.relax_short_control = relax_short_control != 0;
    if (!status)
        status = pl_x86_select_write(
            &frontend, &selection_workspace, &block,
            output, SELECT_OUTPUT_CAPACITY, written, selection);
    return status;
}

static int select(const pl_u8 *bytes, pl_u32 count,
                  pl_u64 start,
                  pl_x86_native_selection *selection,
                  pl_u8 output[SELECT_OUTPUT_CAPACITY], pl_u32 *written)
{
    return select_with_fields(
        bytes, count, start, 0, 0, selection, output, written);
}

static int select_relaxed(const pl_u8 *bytes, pl_u32 count,
                          pl_u64 start,
                          pl_x86_native_selection *selection,
                          pl_u8 output[SELECT_OUTPUT_CAPACITY],
                          pl_u32 *written)
{
    return select_with_fields(
        bytes, count, start, 0, 1, selection, output, written);
}

static int candidates_with_relax(const pl_u8 *bytes, pl_u32 count,
                                 pl_u64 start, int relax_short_control,
                                 pl_x86_native_candidates *out)
{
    pl_x86_map map = {
        bytes, 0x1000u, count, count,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image image = { &map, 1u, 0u, start };
    pl_x86_frontend frontend;
    static pl_u8 first[1024u * 1024u];
    static pl_u8 second[1024u * 1024u];
    static pl_u8 select_first[1024u * 1024u];
    static pl_u8 select_second[1024u * 1024u];
    pl_x86_block_workspace workspace = {
        first, second, sizeof first, 128u,
    };
    pl_x86_block_workspace selection_workspace = {
        select_first, select_second, sizeof select_first, 128u,
    };
    pl_x86_block block;
    int status = pl_x86_frontend_open(&image, &frontend);
    if (!status)
        status = pl_x86_block_lower(
            &frontend, image.entry, &workspace, &block);
    if (!status) block.relax_short_control = relax_short_control != 0;
    if (!status)
        status = pl_x86_select_candidates(
            &frontend, &selection_workspace, &block, out);
    return status;
}

static int candidates(const pl_u8 *bytes, pl_u32 count, pl_u64 start,
                      pl_x86_native_candidates *out)
{
    return candidates_with_relax(bytes, count, start, 0, out);
}

static int write_candidate(const pl_u8 *bytes, pl_u32 count, pl_u64 start,
                           const pl_x86_native_selection *selection,
                           pl_u8 *output, pl_u32 output_capacity,
                           pl_u32 *written)
{
    pl_x86_map map = {
        bytes, 0x1000u, count, count,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image image = { &map, 1u, 0u, start };
    pl_x86_frontend frontend;
    static pl_u8 first[1024u * 1024u];
    static pl_u8 second[1024u * 1024u];
    pl_x86_block_workspace workspace = {
        first, second, sizeof first, 128u,
    };
    pl_x86_block block;
    int status = pl_x86_frontend_open(&image, &frontend);
    if (!status)
        status = pl_x86_block_lower(
            &frontend, image.entry, &workspace, &block);
    if (!status)
        status = pl_x86_select_write_measured(
            &frontend, &block, selection,
            output, output_capacity, written);
    return status;
}

static int select_image_projected(const pl_x86_image *image, pl_u32 count,
                                  pl_u32 live_output_mask, int construction_fields,
                                  pl_x86_native_selection *selection,
                                  pl_u8 output[SELECT_OUTPUT_CAPACITY],
                                  pl_u32 *written, pl_x86_block *formed)
{
    pl_x86_frontend frontend;
    static pl_u8 first[1024u * 1024u];
    static pl_u8 second[1024u * 1024u];
    static pl_u8 select_first[1024u * 1024u];
    static pl_u8 select_second[1024u * 1024u];
    pl_x86_block_workspace workspace = {
        first, second, sizeof first, 64u,
    };
    pl_x86_block_workspace selection_workspace = {
        select_first, select_second, sizeof select_first, 64u,
    };
    pl_x86_block block;
    int status = pl_x86_frontend_open(image, &frontend);
    if (!status)
        status = pl_x86_block_lower_projected_until(
            &frontend, image->entry, image->entry + count,
            live_output_mask, &workspace, &block);
    if (!status) block.construction_fields = construction_fields != 0;
    if (!status && formed) *formed = block;
    if (!status)
        status = pl_x86_select_write(
            &frontend, &selection_workspace, &block,
            output, SELECT_OUTPUT_CAPACITY, written, selection);
    return status;
}

static int select_projected(const pl_u8 *bytes, pl_u32 count,
                            pl_u32 live_output_mask,
                            pl_x86_native_selection *selection,
                            pl_u8 output[SELECT_OUTPUT_CAPACITY],
                            pl_u32 *written, pl_x86_block *formed)
{
    pl_x86_map map = { bytes, 0x1000u, count, count,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u };
    pl_x86_image image = { &map, 1u, 0u, 0x1000u };
    return select_image_projected(&image, count, live_output_mask, 0,
        selection, output, written, formed);
}

static int candidates_projected(
    const pl_u8 *bytes, pl_u32 count, pl_u32 live_output_mask,
    pl_x86_native_candidates *candidates)
{
    pl_x86_map map = {
        bytes, 0x1000u, count, count,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image image = { &map, 1u, 0u, 0x1000u };
    pl_x86_frontend frontend;
    static pl_u8 first[1024u * 1024u];
    static pl_u8 second[1024u * 1024u];
    static pl_u8 select_first[1024u * 1024u];
    static pl_u8 select_second[1024u * 1024u];
    pl_x86_block_workspace workspace = {
        first, second, sizeof first, 64u,
    };
    pl_x86_block_workspace selection_workspace = {
        select_first, select_second, sizeof select_first, 64u,
    };
    pl_x86_block block;
    int status = pl_x86_frontend_open(&image, &frontend);
    if (!status)
        status = pl_x86_block_lower_projected_until(
            &frontend, image.entry, image.entry + count,
            live_output_mask, &workspace, &block);
    if (!status)
        status = pl_x86_select_candidates(
            &frontend, &selection_workspace, &block, candidates);
    return status;
}

static int write_projected_candidate(
    const pl_u8 *bytes, pl_u32 count, pl_u32 live_output_mask,
    const pl_x86_native_selection *selection,
    pl_u8 output[SELECT_OUTPUT_CAPACITY], pl_u32 *written)
{
    pl_x86_map map = {
        bytes, 0x1000u, count, count,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image image = { &map, 1u, 0u, 0x1000u };
    pl_x86_frontend frontend;
    static pl_u8 first[1024u * 1024u];
    static pl_u8 second[1024u * 1024u];
    pl_x86_block_workspace workspace = {
        first, second, sizeof first, 64u,
    };
    pl_x86_block block;
    int status = pl_x86_frontend_open(&image, &frontend);
    if (!status)
        status = pl_x86_block_lower_projected_until(
            &frontend, image.entry, image.entry + count,
            live_output_mask, &workspace, &block);
    if (!status)
        status = pl_x86_select_write_measured(
            &frontend, &block, selection,
            output, SELECT_OUTPUT_CAPACITY, written);
    return status;
}

static void print_block_shape(const pl_x86_block *block)
{
    if (!block) return;
    fprintf(stderr,
            "projected shape: nodes=%u args=%u locals=%u stack=%u "
            "flow=%u successors=%u predicate/fault=%u/%u\n",
            block->plan.node_count, block->plan.argument_count,
            block->plan.local_count, block->plan.stack_count,
            (unsigned)block->flow, block->successor_count,
            (unsigned)block->has_predicate,
            (unsigned)block->has_fault_predicate);
    for (pl_u32 local = 0u; local < block->plan.local_count; ++local) {
        pl_operand value = block->plan.locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local) continue;
        fprintf(stderr, "  local[%u]=%u:%llu\n", local,
                (unsigned)value.kind, (unsigned long long)value.value);
    }
    for (pl_u32 node = 0u; node < block->plan.node_count; ++node) {
        const pl_node *value = &block->plan.nodes[node];
        fprintf(stderr, "  node[%u]=op%u args", node + 1u,
                value->opcode);
        for (pl_u32 at = 0u; at < value->argument_count; ++at) {
            pl_operand argument =
                block->plan.arguments[value->argument_at + at];
            fprintf(stderr, " %u:%llu", (unsigned)argument.kind,
                    (unsigned long long)argument.value);
        }
        fputc('\n', stderr);
    }
}

static int joint_minimum_contract(void)
{
    pl_x86_native_candidates values = { 0 };
    values.count = 2u;
    values.candidate[0] = (pl_x86_native_selection){
        .output_bytes = 1u, .output_work = 8u, .output_span = 1u,
        .supported = 1u,
    };
    values.candidate[1] = (pl_x86_native_selection){
        .output_bytes = 1u, .output_work = 1u, .output_span = 2u,
        .supported = 1u,
    };
    pl_x86_native_selection selected = { 0 };
    pl_u32 span = 0u, work = 0u;
    if (pl_x86_candidates_select_joint_minimum(
            &values, 0u, 0u, &selected, &span, &work)
            != PL_ERROR_X86_PARETO)
        return PL_ERROR_X86_SELECT;
    if (span != 1u || work != 1u) return PL_ERROR_X86_SELECT;

    /* Once one spelling witnesses both independent minima, byte length is a
     * tertiary choice only among those joint witnesses. */
    values.candidate[1].output_span = 1u;
    values.candidate[1].output_bytes = 2u;
    if (pl_x86_candidates_select_joint_minimum(
            &values, 0u, 0u, &selected, &span, &work)
            || selected.output_span != 1u || selected.output_work != 1u
            || selected.output_bytes != 2u)
        return PL_ERROR_X86_SELECT;

    /* Preserve the complete non-dominated set, not the first two enumerated
     * candidates.  Equal physical points keep only the shortest spelling. */
    values = (pl_x86_native_candidates){ 0 };
    values.count = 6u;
    values.candidate[0] = (pl_x86_native_selection){
        .output_span = 1u, .output_work = 9u, .output_bytes = 7u,
        .supported = 1u,
    };
    values.candidate[1] = (pl_x86_native_selection){
        .output_span = 2u, .output_work = 5u, .output_bytes = 6u,
        .supported = 1u,
    };
    values.candidate[2] = (pl_x86_native_selection){
        .output_span = 3u, .output_work = 3u, .output_bytes = 5u,
        .supported = 1u,
    };
    values.candidate[3] = (pl_x86_native_selection){
        .output_span = 4u, .output_work = 2u, .output_bytes = 4u,
        .supported = 1u,
    };
    values.candidate[4] = (pl_x86_native_selection){
        .output_span = 4u, .output_work = 8u, .output_bytes = 3u,
        .supported = 1u,
    };
    values.candidate[5] = values.candidate[2];
    values.candidate[5].output_bytes = 4u;
    pl_x86_native_selection frontier[PL_X86_NATIVE_MAX_CANDIDATES];
    pl_u32 frontier_count = 0u;
    if (pl_x86_candidates_pareto_frontier(
            &values, 1u, 2u, frontier,
            PL_X86_NATIVE_MAX_CANDIDATES, &frontier_count)
            || frontier_count != 4u
            || frontier[0].output_span != 2u
            || frontier[0].output_work != 11u
            || frontier[1].output_span != 3u
            || frontier[1].output_work != 7u
            || frontier[2].output_span != 4u
            || frontier[2].output_work != 5u
            || frontier[2].output_bytes != 4u
            || frontier[3].output_span != 5u
            || frontier[3].output_work != 4u)
        return PL_ERROR_X86_SELECT;
    return 0;
}

int main(void)
{
    static const pl_u8 redundant[] = { 0x90u, 0x90u, 0xc3u };
    static const pl_u8 relative[] = { 0x90u, 0xebu, 0xfdu };
    static const pl_u8 short_conditional[] = { 0x77u, 0xfeu };
    static const pl_u8 stateful[] = { 0x48u, 0x83u, 0xc0u, 0x01u, 0xc3u };
    static const pl_u8 identity_then_stateful[] = {
        0x90u, 0x48u, 0x83u, 0xc0u, 0x01u, 0xc3u
    };
    static const pl_u8 noncanonical_add[] = {
        0x48u, 0x81u, 0xc0u, 0x01u, 0x00u, 0x00u, 0x00u, 0xc3u
    };
    static const pl_u8 noncanonical_insert32[] = {
        0x40u, 0x89u, 0xe5u, 0xc3u
    };
    static const pl_u8 overwritten_prefix[] = {
        0xb8u, 0x01u, 0x00u, 0x00u, 0x00u,
        0xb8u, 0x07u, 0x00u, 0x00u, 0x00u,
        0xc3u,
    };
    static const pl_u8 noncontiguous_overwrite[] = {
        0xbbu, 0x02u, 0x00u, 0x00u, 0x00u,
        0xb8u, 0x01u, 0x00u, 0x00u, 0x00u,
        0xb9u, 0x03u, 0x00u, 0x00u, 0x00u,
        0xb8u, 0x07u, 0x00u, 0x00u, 0x00u,
        0xc3u,
    };
    /* A complete-future projection must remove dead work inside a block, not
     * only at its prefix.  The RAX/RBX exchange remains cyclic until RDX owns
     * entry RAX, so the final-state emitter cannot replace this witness with
     * independent constant/copy publications. */
    static const pl_u8 cyclic_copy_with_dead_middle[] = {
        0xb9u, 0x01u, 0x00u, 0x00u, 0x00u,
        0x48u, 0x89u, 0xc2u,
        0x48u, 0x89u, 0xd8u,
        0x48u, 0x89u, 0xd3u,
        0xb9u, 0x02u, 0x00u, 0x00u, 0x00u,
    };
    static const pl_u8 cyclic_copy_projected[] = {
        0x48u, 0x89u, 0xc2u,
        0x48u, 0x89u, 0xd8u,
        0x48u, 0x89u, 0xd3u,
        0xb9u, 0x02u, 0x00u, 0x00u, 0x00u,
    };
    /* A shift nested under AND/shift/OR is still one normalized value chain.
     * The independent constant publication may move after it; no decoded row
     * or source-order record is required to emit the ordinary x86 body. */
    static const pl_u8 nested_shift_source[] = {
        0xc1u, 0xeau, 0x0bu,
        0x48u, 0xc7u, 0xc7u, 0x58u, 0x68u, 0x8bu, 0x81u,
        0x83u, 0xe2u, 0x01u,
        0xc1u, 0xe2u, 0x0fu,
        0x44u, 0x09u, 0xfau,
    };
    static const pl_u8 nested_shift_result[] = {
        0xc1u, 0xeau, 0x0bu,
        0x83u, 0xe2u, 0x01u,
        0xc1u, 0xe2u, 0x0fu,
        0x44u, 0x09u, 0xfau,
        0x48u, 0xc7u, 0xc7u, 0x58u, 0x68u, 0x8bu, 0x81u,
    };
    /* The second shift is not a final publication: RSI is overwritten by 7.
     * A complete block selector therefore borrows RSI as the physical owner
     * of that right subtree, consumes it in the OR, and only then publishes
     * RSI's final constant.  No source-order record or hidden interpreter is
     * needed for the normalized two-address x86 spelling. */
    static const pl_u8 transient_right_tree_source[] = {
        0x48u, 0x89u, 0xd0u,
        0x48u, 0xd1u, 0xe8u,
        0x48u, 0x89u, 0xd6u,
        0x48u, 0xc1u, 0xeeu, 0x02u,
        0x48u, 0x09u, 0xf0u,
        0xbeu, 0x07u, 0x00u, 0x00u, 0x00u,
    };
    static const pl_u8 transient_right_tree_result[] = {
        0x48u, 0x89u, 0xd6u,
        0x48u, 0xc1u, 0xeeu, 0x02u,
        0x48u, 0x89u, 0xd0u,
        0x48u, 0xd1u, 0xe8u,
        0x48u, 0x09u, 0xf0u,
        0xbeu, 0x07u, 0x00u, 0x00u, 0x00u,
    };
    /* The selected 0/0x2000 value exists only to be ORed into RAX.  The
     * normalized spelling keeps it as a conditional accumulator, narrows
     * the complement to the TEST observation width, and never materializes
     * the transient boolean or mask value. */
    static const pl_u8 conditional_or_source[] = {
        0x48u, 0x89u, 0xd1u,
        0x48u, 0xf7u, 0xd1u,
        0xf7u, 0xc1u, 0x00u, 0x04u, 0x02u, 0x00u,
        0xb9u, 0x00u, 0x00u, 0x00u, 0x00u,
        0xbeu, 0x00u, 0x20u, 0x00u, 0x00u,
        0x48u, 0x0fu, 0x44u, 0xceu,
        0x48u, 0x09u, 0xc8u,
        0xb9u, 0x07u, 0x00u, 0x00u, 0x00u,
        0xbeu, 0x09u, 0x00u, 0x00u, 0x00u,
    };
    static const pl_u8 conditional_or_result[] = {
        0x48u, 0x89u, 0xc1u,
        0x80u, 0xcdu, 0x20u,
        0x89u, 0xd6u,
        0xf7u, 0xd6u,
        0x81u, 0xe6u, 0x00u, 0x04u, 0x02u, 0x00u,
        0x48u, 0x0fu, 0x44u, 0xc1u,
        0xb9u, 0x07u, 0x00u, 0x00u, 0x00u,
        0xbeu, 0x09u, 0x00u, 0x00u, 0x00u,
    };
    static const pl_u8 rip_relative[] = {
        0x48u, 0x8du, 0x05u, 0x00u, 0x00u, 0x00u, 0x00u, 0xc3u
    };
    static const pl_u8 constant_widths[] = {
        0x41u, 0xb8u, 0x44u, 0x33u, 0x22u, 0x11u,
        0x49u, 0xc7u, 0xc1u, 0xffu, 0xffu, 0xffu, 0xffu,
        0x49u, 0xbau, 0x88u, 0x77u, 0x66u, 0x55u,
        0x44u, 0x33u, 0x22u, 0x11u,
        0xc3u,
    };
    static const pl_u8 noncontiguous_copy[] = {
        0x48u, 0x89u, 0xc3u,
        0x48u, 0x89u, 0xd1u,
        0x48u, 0x89u, 0xfeu,
        0x4cu, 0x89u, 0xc1u,
        0xc3u,
    };
    static const pl_u8 dependent_copy[] = {
        0x48u, 0x89u, 0xc2u,
        0x48u, 0x89u, 0xf1u,
        0x48u, 0x89u, 0xd8u,
        0x48u, 0x89u, 0xf9u,
        0xc3u,
    };
    static const pl_u8 invalid_fault[] = { 0x37u };
    static const pl_u8 affine_overwrite[] = {
        0x48u, 0x8du, 0x47u, 0x01u,
        0x48u, 0x8du, 0x47u, 0x02u,
        0xc3u,
    };
    static const pl_u8 affine_and_copy[] = {
        0x48u, 0x8du, 0x75u, 0xa0u,
        0x48u, 0x89u, 0xdfu,
        0xc3u,
    };
    static const pl_u8 alu_and_old_value_copy[] = {
        0x48u, 0x89u, 0xe2u,
        0x48u, 0x83u, 0xe4u, 0xf0u,
        0xc3u,
    };
    static const pl_u8 parallel_alu_and_address[] = {
        0x45u, 0x31u, 0xc0u,
        0x31u, 0xc9u,
        0x48u, 0x8du, 0x3du, 0x00u, 0x00u, 0x00u, 0x00u,
        0xc3u,
    };
    static const pl_u8 equal_address_dead_compare[] = {
        0x48u, 0x8du, 0x3du, 0x19u, 0x00u, 0x00u, 0x00u,
        0x48u, 0x8du, 0x05u, 0x12u, 0x00u, 0x00u, 0x00u,
        0x48u, 0x39u, 0xf8u,
        0x74u, 0xedu,
    };
    static const pl_u8 inverse_stack_adjust[] = {
        0x48u, 0x83u, 0xecu, 0x08u,
        0x48u, 0x83u, 0xc4u, 0x08u,
    };
    /* Linux ex_handler_zeropad.  The source preserves RAX in R8 before
     * alignment, but the normalized graph permits RAX to own the shared
     * aligned value first and only then publishes R8. */
    static const pl_u8 aligned_successor_compare[] = {
        0x49u, 0x89u, 0xc0u,
        0x49u, 0x83u, 0xe0u, 0xf8u,
        0x49u, 0x8du, 0x40u, 0x08u,
        0x48u, 0x39u, 0xd8u,
        0x75u, 0x92u,
    };
    /* Linux workqueue_unbound_housekeeping_update before the following load.
     * RCX and flags are overwritten by that successor barrier. */
    static const pl_u8 shared_low_bit[] = {
        0x48u, 0x89u, 0xc1u,
        0x48u, 0x21u, 0xd1u,
        0x48u, 0x89u, 0xceu,
        0x83u, 0xe6u, 0x01u,
        0x83u, 0xe1u, 0x01u,
    };
    /* Linux bump_cpu_timer.  Substituting the final RSI definition into RDX
     * cancels +RAX-RAX before register allocation. */
    static const pl_u8 cancelled_affine_compare[] = {
        0x48u, 0x01u, 0xc6u,
        0x31u, 0xc9u,
        0x4cu, 0x29u, 0xc6u,
        0x48u, 0x89u, 0xf2u,
        0x48u, 0x29u, 0xc2u,
        0x48u, 0x39u, 0xd0u,
        0x73u, 0x50u,
    };
    /* Linux pipe_ioctl loop prologue, including its alignment padding. */
    static const pl_u8 zero_idiom_after_affine[] = {
        0x8du, 0x78u, 0xffu,
        0x31u, 0xc0u,
        0x66u, 0x0fu, 0x1fu, 0x84u, 0x00u,
        0x00u, 0x00u, 0x00u, 0x00u,
        0x66u, 0x66u, 0x2eu, 0x0fu, 0x1fu, 0x84u,
        0x00u, 0x00u, 0x00u, 0x00u, 0x00u,
    };
    /* Linux squashfs_readahead before its first store barrier.  Both the
     * negated value and its masked derivative survive the cut. */
    static const pl_u8 shared_negated_mask[] = {
        0x49u, 0x89u, 0xc5u,
        0x49u, 0xf7u, 0xddu,
        0x4cu, 0x89u, 0xe9u,
        0x48u, 0x21u, 0xd1u,
    };
    /* Linux dmi_decode_table.  R8 publishes a subtract which the following
     * RAX affine value consumes; R14 is an independent copy of the same
     * entry value and must stay in the first wave. */
    static const pl_u8 published_affine_branch[] = {
        0x49u, 0x89u, 0xdeu,
        0x4du, 0x89u, 0xf0u,
        0x4du, 0x29u, 0xe8u,
        0x49u, 0x8du, 0x40u, 0x04u,
        0x48u, 0x39u, 0xc6u,
        0x73u, 0x9bu,
    };
    /* Linux perf_event_print_debug.cold before its load barrier.  The one
     * sign-extension node and four independent publications are one dense
     * normalized frame; MOVSXD must not force the whole source family. */
    static const pl_u8 sign_extend_publication[] = {
        0x48u, 0x89u, 0xe9u,
        0x48u, 0xc7u, 0xc7u, 0x78u, 0xf7u, 0x8au, 0x81u,
        0x49u, 0x89u, 0xc7u,
        0x49u, 0x63u, 0xc6u,
        0x48u, 0x89u, 0xc3u,
    };
    /* One shared 64-bit parent feeds equal 64-bit and 32-bit subtraction
     * laws.  The low-word result is a quotient of the wide result: publish
     * the parent once, perform one wide subtraction, and copy its low word.
     * Recomputing the 32-bit tree would add two instructions and split the
     * work/span Pareto frontier. */
    static const pl_u8 arithmetic_width_source[] = {
        0xc1u, 0xe2u, 0x20u,
        0x48u, 0x89u, 0xceu,
        0x48u, 0x89u, 0xd1u,
        0x48u, 0x09u, 0xc1u,
        0x48u, 0x89u, 0xc8u,
        0x48u, 0x29u, 0xf0u,
        0x89u, 0xc2u,
        0x48u, 0x39u, 0xf8u,
        0x48u, 0x0fu, 0x42u, 0xfau,
        0x49u, 0x39u, 0xc0u,
        0x4cu, 0x0fu, 0x42u, 0xc2u,
        0x41u, 0x83u, 0xc1u, 0x01u,
    };
    static const pl_u8 arithmetic_width_result[] = {
        0x48u, 0x89u, 0xceu,
        0x48u, 0x09u, 0xd0u,
        0x48u, 0x89u, 0xc1u,
        0x48u, 0x29u, 0xf0u,
        0x89u, 0xc2u,
        0x48u, 0x39u, 0xf8u,
        0x48u, 0x0fu, 0x42u, 0xfau,
        0x49u, 0x39u, 0xc0u,
        0x4cu, 0x0fu, 0x42u, 0xc2u,
        0x41u, 0x83u, 0xc1u, 0x01u,
    };
    /* The final destination already owns the left input of SUB.  Borrowing a
     * different dying register would require save, seed and copy-back moves.
     * Update RAX in place, then share the final zero producer by register
     * renaming for the remaining publications. */
    static const pl_u8 inplace_owner_source[] = {
        0x48u, 0x89u, 0xc2u,
        0x48u, 0x29u, 0xcau,
        0x48u, 0x89u, 0xd0u,
        0x31u, 0xd2u,
        0x31u, 0xc9u,
        0x31u, 0xf6u,
        0x31u, 0xffu,
    };
    static const pl_u8 inplace_owner_result[] = {
        0x48u, 0x29u, 0xc8u,
        0x31u, 0xffu,
        0x89u, 0xf9u,
        0x89u, 0xfau,
        0x89u, 0xfeu,
    };
    /* Each shared subtree has one physical owner.  Seed the commutative R10
     * root with its independent R14 side, then join the published R13 owner;
     * independent shift and affine branches start together without either a
     * rebuilt subtree or a copy into R10. */
    static const pl_u8 published_subtree_source[] = {
        0x4du, 0x8du, 0x4bu, 0x01u,
        0xb8u, 0x01u, 0x00u, 0x00u, 0x00u,
        0x4du, 0x21u, 0xf1u,
        0x48u, 0xd3u, 0xe0u,
        0x4du, 0x89u, 0xcdu,
        0x49u, 0x29u, 0xc5u,
        0x4du, 0x89u, 0xeau,
        0x4du, 0x21u, 0xf2u,
    };
    static const pl_u8 published_subtree_result[] = {
        0x4du, 0x89u, 0xf2u,
        0xb8u, 0x01u, 0x00u, 0x00u, 0x00u,
        0x48u, 0xd3u, 0xe0u,
        0x4du, 0x8du, 0x4bu, 0x01u,
        0x4du, 0x21u, 0xf1u,
        0x4du, 0x89u, 0xcdu,
        0x49u, 0x29u, 0xc5u,
        0x4du, 0x21u, 0xeau,
    };
    /* A final TEST publishes only flags, so its entry operand has to remain
     * live until every preceding flag-clobbering result is complete.  The
     * affine RDX result may still read that old RAX value before the final
     * constant overwrites RAX; no save or source-byte fallback is required. */
    static const pl_u8 standalone_flags_source[] = {
        0x48u, 0x89u, 0xd6u,
        0x48u, 0x8du, 0x54u, 0x02u, 0xffu,
        0x48u, 0xc1u, 0xeeu, 0x0cu,
        0x48u, 0xc1u, 0xeau, 0x0cu,
        0x48u, 0x85u, 0xc0u,
        0x48u, 0xc7u, 0xc0u, 0xffu, 0xffu, 0xffu, 0xffu,
    };
    static const pl_u8 standalone_flags_result[] = {
        0x48u, 0x89u, 0xd6u,
        0x48u, 0xc1u, 0xeeu, 0x0cu,
        0x48u, 0x8du, 0x54u, 0x10u, 0xffu,
        0x48u, 0xc1u, 0xeau, 0x0cu,
        0x48u, 0x85u, 0xc0u,
        0x48u, 0xc7u, 0xc0u, 0xffu, 0xffu, 0xffu, 0xffu,
    };
    /* A published shift result is already a physical input to the following
     * addition.  Reuse that owner in LEA so the correct shift flags survive;
     * recursively shifting a second register would add work and destroy the
     * observed RFLAGS value. */
    static const pl_u8 published_add_after_flags_source[] = {
        0x48u, 0x01u, 0xcau,
        0x48u, 0x89u, 0xf1u,
        0x48u, 0xc1u, 0xe9u, 0x02u,
        0x48u, 0x8du, 0x34u, 0x01u,
        0xe9u, 0x00u, 0x00u, 0x00u, 0x00u,
    };
    static const pl_u8 published_add_after_flags_result[] = {
        0x48u, 0x8du, 0x14u, 0x11u,
        0x48u, 0x89u, 0xf1u,
        0x48u, 0xc1u, 0xe9u, 0x02u,
        0x48u, 0x8du, 0x34u, 0x08u,
        0xebu, 0x00u,
    };
    /* CMP reads the final published affine values, not the entry registers
     * nested inside their definitions.  Both owners must be complete before
     * CMP; only then may the result register and observed flags coexist. */
    static const pl_u8 published_compare_source[] = {
        0x8du, 0x86u, 0x00u, 0x00u, 0x20u, 0x00u,
        0x48u, 0x25u, 0x00u, 0x00u, 0xe0u, 0xffu,
        0x48u, 0x8du, 0x70u, 0xffu,
        0x48u, 0x8du, 0x51u, 0xffu,
        0x48u, 0x39u, 0xd6u,
    };
    static const pl_u8 published_compare_direct[] = {
        0x8du, 0x86u, 0x00u, 0x00u, 0x20u, 0x00u,
        0x48u, 0x25u, 0x00u, 0x00u, 0xe0u, 0xffu,
        0x48u, 0x8du, 0x51u, 0xffu,
        0x48u, 0x8du, 0x70u, 0xffu,
        0x48u, 0x39u, 0xd6u,
    };
    /* When one value is published to several registers, an equal output
     * which is also its entry source is the unique in-place accumulator.
     * Keeping R15 as that owner removes copy-back/restore work while RCX is
     * only a final fanout and RAX consumes the same parent directly. */
    static const pl_u8 shared_inplace_owner_source[] = {
        0x24u, 0x74u,
        0x4au, 0x4cu, 0x89u, 0xfdu,
        0x48u, 0x8du, 0x8du, 0x00u, 0x00u, 0x00u, 0x40u,
        0x4cu, 0x89u, 0xf7u,
        0x48u, 0x81u, 0xe1u, 0x00u, 0x00u, 0x00u, 0xc0u,
        0x48u, 0x8du, 0x41u, 0xffu,
        0x49u, 0x89u, 0xcfu,
        0x4cu, 0x39u, 0xe0u,
    };
    static const pl_u8 shared_inplace_owner_result[] = {
        0x4cu, 0x89u, 0xfdu,
        0x4cu, 0x89u, 0xf7u,
        0x4du, 0x8du, 0xbfu, 0x00u, 0x00u, 0x00u, 0x40u,
        0x49u, 0x81u, 0xe7u, 0x00u, 0x00u, 0x00u, 0xc0u,
        0x49u, 0x8du, 0x47u, 0xffu,
        0x4cu, 0x39u, 0xe0u,
        0x4cu, 0x89u, 0xf9u,
    };
    /* Two children share one internal value: XOR consumes it while ROR
     * updates its owner, then SUB joins both children.  Publish the XOR child
     * to the now-dead root register before ROR; this preserves ten-work
     * minimum while reducing the destructive-register critical path. */
    static const pl_u8 shared_diamond_source[] = {
        0x29u, 0xc1u,
        0x31u, 0xcau,
        0xc1u, 0xc9u, 0x08u,
        0x29u, 0xcau,
        0x89u, 0xd0u,
        0x31u, 0xd2u,
        0x31u, 0xc9u,
        0x31u, 0xf6u,
        0x31u, 0xffu,
        0x45u, 0x31u, 0xc0u,
    };
    static const pl_u8 shared_diamond_result[] = {
        0x29u, 0xc1u,
        0x31u, 0xcau,
        0x89u, 0xd0u,
        0xc1u, 0xc9u, 0x08u,
        0x29u, 0xc8u,
        0x31u, 0xc9u,
        0x31u, 0xd2u,
        0x31u, 0xf6u,
        0x31u, 0xffu,
        0x45u, 0x31u, 0xc0u,
    };
    /* Linux's stack-frame prologue exposes two independent normalization
     * laws at once.  The 32-bit affine result belongs directly in EAX, and
     * the final SUB must remain the joint producer of RSP and RFLAGS.  The
     * other addresses substitute the entry RSP, so all five instructions
     * form one wave; LEA may not replace the flag-producing SUB. */
    static const pl_u8 affine_fanout_flags_source[] = {
        0x8du, 0x81u, 0x55u, 0x89u, 0xcdu, 0x53u,
        0x48u, 0x89u, 0xd3u,
        0x48u, 0x83u, 0xecu, 0x10u,
        0x48u, 0x8du, 0x4cu, 0x24u, 0x04u,
        0x48u, 0x8du, 0x54u, 0x24u, 0x08u,
    };
    static const pl_u8 affine_fanout_flags_result[] = {
        0x8du, 0x81u, 0x55u, 0x89u, 0xcdu, 0x53u,
        0x48u, 0x8du, 0x4cu, 0x24u, 0xf4u,
        0x48u, 0x89u, 0xd3u,
        0x48u, 0x8du, 0x54u, 0x24u, 0xf8u,
        0x48u, 0x83u, 0xecu, 0x10u,
    };
    /* One coordinate can carry two generations in the same normalized root:
     * entry EDX contributes n1 while final EDX contributes n15.  Seed n1
     * once into R12, share that transient owner with the RAX branch, publish
     * final EDX, then join it into R12.  Cancelling the two EDX roles either
     * reads the wrong generation or recomputes n1; neither is a valid quotient.
     */
    static const pl_u8 generation_join_source[] = {
        0x44u, 0x8du, 0xa2u, 0x72u, 0xf3u, 0x6eu, 0x3cu,
        0x41u, 0x81u, 0xf2u, 0x19u, 0xcdu, 0xe0u, 0x5bu,
        0xc1u, 0xceu, 0x08u,
        0x44u, 0x31u, 0xe0u,
        0x41u, 0xc1u, 0xc2u, 0x10u,
        0x41u, 0x01u, 0xf3u,
        0xc1u, 0xc8u, 0x0cu,
        0x41u, 0x8du, 0xaau, 0x3au, 0xf5u, 0x4fu, 0xa5u,
        0x45u, 0x31u, 0xd8u,
        0x41u, 0x01u, 0xc6u,
        0x31u, 0xe9u,
        0x41u, 0xc1u, 0xc8u, 0x07u,
        0x44u, 0x31u, 0xf2u,
        0xc1u, 0xc9u, 0x0cu,
        0xc1u, 0xcau, 0x08u,
        0x41u, 0x01u, 0xcdu,
        0x41u, 0x01u, 0xd4u,
    };
    /* A commutative two-address operation whose right semantic operand is
     * already the destination is normalized by swapping operands, not by
     * saving the destination and seeding it again.  The release-wide result
     * keeps the nine-work minimum and exposes the four-wave SSA span. */
    static const pl_u8 commutative_inplace_source[] = {
        0x31u, 0xcfu,
        0xc1u, 0xcfu, 0x08u,
        0x45u, 0x31u, 0xd8u,
        0x01u, 0xfbu,
        0x41u, 0xc1u, 0xc8u, 0x0cu,
        0x41u, 0x31u, 0xdfu,
        0x45u, 0x01u, 0xc2u,
        0x44u, 0x31u, 0xd6u,
        0x45u, 0x89u, 0xfeu,
    };
    /* The rotate of entry EAX is consumed both by R10 and by final EAX.
     * Give that subtree EAX as its transient physical owner, consume it from
     * R10, and only then join the independently published EBP value.  The
     * normalized graph has twelve semantic nodes; x86-64-v2 needs one extra
     * MOV to fan the R15 value into the independently rotated R14 output, so
     * thirteen work and six waves are the joint physical minimum. */
    static const pl_u8 shared_rotate_join_source[] = {
        0x45u, 0x31u, 0xe0u,
        0xc1u, 0xc8u, 0x0cu,
        0x41u, 0xc1u, 0xc8u, 0x0cu,
        0x41u, 0x01u, 0xc2u,
        0x45u, 0x01u, 0xc1u,
        0x44u, 0x31u, 0xd7u,
        0x45u, 0x31u, 0xcfu,
        0xc1u, 0xcfu, 0x08u,
        0x45u, 0x89u, 0xfeu,
        0x01u, 0xfdu,
        0x41u, 0xc1u, 0xceu, 0x08u,
        0x31u, 0xe8u,
        0x45u, 0x01u, 0xf4u,
    };
    /* For t=x>>1, the original threshold x<=6 differs from t<=3 only at
     * x=7.  Both select arms are one at that boundary, so the complete future
     * cannot distinguish it: compare t directly, form t-2 with flag-neutral
     * LEA, then CMOV.  No copy of x and no rebuilt quotient survive. */
    static const pl_u8 quotient_boundary_source[] = {
        0x48u, 0x89u, 0xc2u,
        0x48u, 0xd1u, 0xe8u,
        0x48u, 0x83u, 0xe8u, 0x02u,
        0x48u, 0x83u, 0xfau, 0x06u,
        0xbau, 0x01u, 0x00u, 0x00u, 0x00u,
        0x48u, 0x0fu, 0x46u, 0xc2u,
        0x48u, 0x01u, 0xc6u,
    };
    static const pl_u8 quotient_boundary_result[] = {
        0xbau, 0x01u, 0x00u, 0x00u, 0x00u,
        0x48u, 0xd1u, 0xe8u,
        0x48u, 0x83u, 0xf8u, 0x03u,
        0x48u, 0x8du, 0x40u, 0xfeu,
        0x48u, 0x0fu, 0x46u, 0xc2u,
        0x48u, 0x01u, 0xc6u,
    };
    /* A 32-bit destination observes only low32 of its 64-bit addressing
     * coordinate.  Preserve the base-less scaled-index LEA directly; a
     * SHL64 + ADD32 + MOV32 reconstruction is the same value with two units
     * of needless work.  Immediate compare then gives the joint 5/2 point. */
    static const pl_u8 low32_scaled_index_source[] = {
        0x8du, 0x0cu, 0xc5u, 0xb8u, 0x94u, 0xabu, 0x81u,
        0xb8u, 0x20u, 0x00u, 0x00u, 0x00u,
        0xbeu, 0x20u, 0x28u, 0x00u, 0x00u,
        0x39u, 0xc2u,
        0x0fu, 0x47u, 0xd0u,
    };
    static const pl_u8 low32_scaled_index_result[] = {
        0x8du, 0x0cu, 0xc5u, 0xb8u, 0x94u, 0xabu, 0x81u,
        0xb8u, 0x20u, 0x00u, 0x00u, 0x00u,
        0x83u, 0xfau, 0x20u,
        0x0fu, 0x47u, 0xd0u,
        0xbeu, 0x20u, 0x28u, 0x00u, 0x00u,
    };
    /* The old RDX value is copied to RSI while RDX publishes XOR(x,x).
     * Zero and its flags do not depend on x, so publication-owner rebinding
     * must not turn the self-XOR into XOR RDX,RSI and a false second wave. */
    static const pl_u8 self_zero_copy_source[] = {
        0x89u, 0xc1u,
        0x48u, 0x89u, 0xd6u,
        0x49u, 0x89u, 0xc8u,
        0x31u, 0xd2u,
        0xb9u, 0x06u, 0x00u, 0x00u, 0x00u,
    };
    static const pl_u8 self_zero_copy_result[] = {
        0xb9u, 0x06u, 0x00u, 0x00u, 0x00u,
        0x48u, 0x89u, 0xd6u,
        0x31u, 0xd2u,
        0x41u, 0x89u, 0xc0u,
    };
    /* When an arithmetic result is published to two coordinates, a direct
     * root entry is the destructive owner before any transitive source.  The
     * final `RSI xor n6` therefore runs in RSI and fans once to RDX; choosing
     * transitive RDX would require save, compute, and copy-back. */
    static const pl_u8 root_accumulator_source[] = {
        0x31u, 0xf0u,
        0xc1u, 0xc1u, 0x10u,
        0x29u, 0xc8u,
        0x31u, 0xc2u,
        0x89u, 0xc7u,
        0x89u, 0xd1u,
        0xc1u, 0xc7u, 0x04u,
        0x29u, 0xf9u,
        0x31u, 0xceu,
        0x89u, 0xf2u,
    };
    /* The unpublished RDX xor intermediate can be constructed directly in
     * ECX. Width inference now keeps both nested word results at 32 bits. */
    static const pl_u8 root_accumulator_result[] = {
        0xc1u, 0xc1u, 0x10u, 0x31u, 0xf0u, 0x29u, 0xc8u,
        0x89u, 0xc7u, 0xc1u, 0xc7u, 0x04u, 0x89u, 0xd1u,
        0x31u, 0xc1u, 0x29u, 0xf9u, 0x31u, 0xceu, 0x89u, 0xf2u,
    };
    /* Both CMOV arms derive from the old EBP coordinate while the condition's
     * AND result is also the final EDX and RFLAGS publication.  Materialize
     * the two affine arms in one wave, emit AND once, then let CMOV and its
     * successor consume the result.  A separate TEST has identical flags but
     * adds work; updating EBP before ECX adds an avoidable dependency wave. */
    static const pl_u8 shared_flag_select_source[] = {
        0x83u, 0xc5u, 0x08u,
        0x81u, 0xe2u, 0x80u, 0x00u, 0x00u, 0x00u,
        0x8du, 0x4du, 0x04u,
        0x0fu, 0x45u, 0xe9u,
        0x44u, 0x8du, 0x24u, 0x2eu,
    };
    static const pl_u8 shared_flag_select_result[] = {
        0x8du, 0x4du, 0x0cu,
        0x8du, 0x6du, 0x08u,
        0x81u, 0xe2u, 0x80u, 0x00u, 0x00u, 0x00u,
        0x0fu, 0x45u, 0xe9u,
        0x44u, 0x8du, 0x24u, 0x2eu,
    };
    static const pl_u8 stack_frame_publication[] = {
        0x48u, 0x83u, 0xecu, 0x40u,
        0x4cu, 0x8du, 0x87u, 0x00u, 0x08u, 0x00u, 0x00u,
        0xb9u, 0x08u, 0x00u, 0x00u, 0x00u,
        0x83u, 0xfeu, 0x01u,
        0x48u, 0x89u, 0xe7u,
        0xb8u, 0x00u, 0x00u, 0x00u, 0x00u,
    };
    /* Linux's first full-image normalization escape.  The explicit count
     * mask in SSA is already implemented by x86's D3 shift instruction and
     * must not reopen the source-byte fallback. */
    static const pl_u8 dynamic_shift_mask[] = {
        0x48u, 0xc7u, 0xc0u, 0xffu, 0xffu, 0xffu, 0xffu,
        0x48u, 0xd3u, 0xe0u,
    };
    static const pl_u8 tail_jump_frame[] = {
        0x48u, 0xc7u, 0xc7u, 0x01u, 0x00u, 0x00u, 0x00u,
        0x48u, 0x83u, 0xc4u, 0x10u,
        0xe9u, 0x00u, 0x00u, 0x00u, 0x00u,
    };
    static const pl_u8 alu_projection_fanout[] = {
        0x48u, 0x83u, 0xc3u, 0x07u,
        0x48u, 0x8du, 0x8du, 0x70u, 0xffu, 0xffu, 0xffu,
        0x48u, 0x8du, 0x95u, 0x78u, 0xffu, 0xffu, 0xffu,
        0x4cu, 0x89u, 0xe6u,
        0x48u, 0x83u, 0xe3u, 0xf8u,
        0x48u, 0x89u, 0xdfu,
    };
    static const pl_u8 entry_flags_select[] = {
        0x48u, 0xc7u, 0xc2u, 0xc0u, 0x39u, 0x8du, 0x81u,
        0x4cu, 0x89u, 0xf6u,
        0x48u, 0xc7u, 0xc0u, 0xe6u, 0xd9u, 0x8du, 0x81u,
        0x48u, 0x0fu, 0x45u, 0xd0u,
    };
    static const pl_u8 divide_sign_high[] = {
        0xb9u, 0xe8u, 0x03u, 0x00u, 0x00u,
        0x48u, 0x89u, 0xc7u,
        0x89u, 0xd0u,
        0x99u,
    };
    static const pl_u8 word_split_publication[] = {
        0x48u, 0x89u, 0xd6u,
        0x48u, 0x83u, 0xe6u, 0xefu,
        0x48u, 0x89u, 0xf2u,
        0xb9u, 0x23u, 0x01u, 0x00u, 0x00u,
        0x89u, 0xf0u,
        0x48u, 0xc1u, 0xeau, 0x20u,
    };
    static const pl_u8 preserved_flag_prefix_branch[] = {
        0xfcu,
        0x48u, 0x89u, 0xd0u,
        0x48u, 0x39u, 0xd6u,
        0x0fu, 0x84u, 0x00u, 0x00u, 0x00u, 0x00u,
    };
    /* The final flag producer's own value publication is a `sub`, and an
     * independent value-sum tree (`imul` then `add`) clobbers the flags on the
     * way to `rsi`.  The scheduler must emit the clobbering tree before the
     * flag producer, so the terminal `jne` reads the `sub` result; emitting
     * the `sub` first leaves the branch reading the `add` flags. */
    static const pl_u8 flag_producer_after_clobbering_add[] = {
        0x48u, 0x69u, 0xf6u, 0x6du, 0x4eu, 0xc6u, 0x41u,
        0x48u, 0x81u, 0xc6u, 0x39u, 0x30u, 0x00u, 0x00u,
        0x83u, 0xe8u, 0x01u,
        0x0fu, 0x85u, 0xe9u, 0xffu, 0xffu, 0xffu,
    };
    static const pl_u8 flag_producer_after_clobbering_add_result[] = {
        0x48u, 0x69u, 0xf6u, 0x6du, 0x4eu, 0xc6u, 0x41u,
        0x48u, 0x81u, 0xc6u, 0x39u, 0x30u, 0x00u, 0x00u,
        0x83u, 0xe8u, 0x01u,
        0x75u, 0x00u,
    };
    static const pl_u8 live_flags_dead_value[] = {
        0x04u, 0xc3u,
        0x0fu, 0x1fu, 0x84u, 0x00u, 0x00u, 0x00u, 0x00u, 0x00u,
        0x8du, 0x04u, 0xbdu, 0x00u, 0x00u, 0x00u, 0x00u,
    };
    static const pl_u8 overwritten_copy_branch[] = {
        0x89u, 0xfbu,
        0x4cu, 0x89u, 0xf3u,
        0x4cu, 0x89u, 0xdfu,
        0x48u, 0x83u, 0xc5u, 0x08u,
        0x4du, 0x39u, 0xe3u,
        0x0fu, 0x85u, 0x00u, 0x00u, 0x00u, 0x00u,
    };
    static const pl_u8 chained_affine_select[] = {
        0x45u, 0x49u, 0x89u, 0xeeu,
        0x49u, 0x8du, 0xaeu, 0x00u, 0x00u, 0x20u, 0x00u,
        0x4cu, 0x89u, 0xe7u,
        0x48u, 0x81u, 0xe5u, 0x00u, 0x00u, 0xe0u, 0xffu,
        0x48u, 0x8du, 0x45u, 0xffu,
        0x48u, 0x39u, 0xd8u,
        0x49u, 0x0fu, 0x43u, 0xefu,
    };
    static const pl_u8 independent_increment_branch[] = {
        0xffu, 0xc3u,
        0x0fu, 0x1fu, 0x80u, 0x00u, 0x00u, 0x00u, 0x00u,
        0x48u, 0x89u, 0xf8u,
        0x48u, 0x85u, 0xffu,
        0x74u, 0x12u,
    };
    static const pl_u8 overwritten_select_common_zero[] = {
        0x0fu, 0x47u, 0xc7u,
        0x45u, 0x31u, 0xd2u,
        0x31u, 0xf6u,
        0x4cu, 0x89u, 0xc7u,
        0x0fu, 0x1fu, 0x80u, 0x00u, 0x00u, 0x00u, 0x00u,
        0x66u, 0x66u, 0x2eu, 0x0fu, 0x1fu, 0x84u, 0x00u,
        0x00u, 0x00u, 0x00u, 0x00u,
        0xb8u, 0x00u, 0x10u, 0x00u, 0x00u,
        0x48u, 0x89u, 0xf2u,
    };
    static const pl_u8 paired_variable_shift[] = {
        0x89u, 0xf2u,
        0x44u, 0x8du, 0x4fu, 0xffu,
        0x89u, 0xf2u,
        0xbbu, 0x01u, 0x00u, 0x00u, 0x00u,
        0x41u, 0xd3u, 0xe2u,
        0xd3u, 0xe3u,
        0x44u, 0x89u, 0xf1u,
    };
    static const pl_u8 zero_shift_publication[] = {
        0x3cu, 0x24u,
        0x31u, 0xc0u,
        0x66u, 0x2eu, 0x0fu, 0x1fu, 0x84u, 0x00u,
        0x00u, 0x00u, 0x00u, 0x00u,
        0x66u, 0x66u, 0x2eu, 0x0fu, 0x1fu, 0x84u, 0x00u,
        0x00u, 0x00u, 0x00u, 0x00u,
        0x48u, 0x89u, 0xc2u,
        0x48u, 0xc1u, 0xeau, 0x02u,
    };
    static const pl_u8 shared_add_after_shift[] = {
        0xc1u, 0xe4u, 0x04u,
        0x49u, 0x01u, 0xc4u,
        0xb8u, 0x01u, 0x00u, 0x00u, 0x00u,
        0x4cu, 0x89u, 0xe1u,
        0x0fu, 0x1fu, 0x40u, 0x00u,
        0x66u, 0x66u, 0x2eu, 0x0fu, 0x1fu, 0x84u, 0x00u,
        0x00u, 0x00u, 0x00u, 0x00u,
    };
    static const pl_u8 live_select_common_zero[] = {
        0x4du, 0x0fu, 0x47u, 0xc7u,
        0x45u, 0x31u, 0xd2u,
        0x31u, 0xf6u,
        0x4cu, 0x89u, 0xc7u,
        0x0fu, 0x1fu, 0x80u, 0x00u, 0x00u, 0x00u, 0x00u,
        0x66u, 0x66u, 0x2eu, 0x0fu, 0x1fu, 0x84u, 0x00u,
        0x00u, 0x00u, 0x00u, 0x00u,
        0xb8u, 0x00u, 0x10u, 0x00u, 0x00u,
        0x48u, 0x89u, 0xf2u,
    };
    static const pl_u8 zero_plus_one_publications[] = {
        0x31u, 0xc0u,
        0x0fu, 0x1fu, 0x84u, 0x00u, 0x00u, 0x00u, 0x00u, 0x00u,
        0x8du, 0x50u, 0x01u,
        0x89u, 0xc1u,
        0x48u, 0x89u, 0xd0u,
    };
    static const pl_u8 shift_copy_overwrite_jump[] = {
        0xbcu, 0x81u, 0xe9u, 0xc1u, 0x65u,
        0xd1u, 0xffu,
        0x90u,
        0x48u, 0x89u, 0xfeu,
        0x48u, 0xc7u, 0xc7u, 0x60u, 0x19u, 0xbcu, 0x81u,
        0xe9u, 0xb1u, 0x65u, 0xd1u, 0xffu,
    };
    static const pl_u8 constant_and_shift[] = {
        0x48u, 0xc7u, 0xc3u, 0x27u, 0x62u, 0x60u, 0x81u,
        0x48u, 0x89u, 0xeeu,
        0x48u, 0x81u, 0xe3u, 0x00u, 0xf0u, 0xffu, 0xffu,
        0x48u, 0xc1u, 0xeeu, 0x0au,
    };
    /* Generic multiply/high-half/add/carry selector witness.  The full CIOS
     * corpus exercises the same arithmetic family with memory cuts, but this
     * register-only fixture is intentionally independent and must not be
     * presented as a complete or byte-for-byte bn_mul_mont lowering. */
    static const pl_u8 mul_add_carry_source[] = {
        0x48u, 0x89u, 0xc8u,
        0x48u, 0x0fu, 0xafu, 0xc7u,
        0x48u, 0xf7u, 0xe2u,
        0x31u, 0xc0u,
        0x48u, 0x85u, 0xffu,
        0x0fu, 0x95u, 0xc0u,
        0x31u, 0xc9u,
        0x48u, 0x01u, 0xf0u,
        0x0fu, 0x92u, 0xc1u,
        0x48u, 0x01u, 0xd0u,
        0x48u, 0x83u, 0xd1u, 0x00u,
        0x48u, 0x89u, 0xcau,
    };
    static const pl_u8 mul_add_carry_result[] = {
        0x48u, 0x89u, 0xc8u,
        0x48u, 0x0fu, 0xafu, 0xc7u,
        0x48u, 0xf7u, 0xe2u,
        0x48u, 0x89u, 0xd0u,
        0x31u, 0xd2u,
        0x48u, 0xf7u, 0xdfu,
        0x48u, 0x11u, 0xf0u,
        0x48u, 0x83u, 0xd2u, 0x00u,
    };
    /* Linux first full-output normalization witness at ffffffff81201074.
     * NEG AX defines CF; SBB ESI,ESI must consume that exact definition, not
     * the block-entry RFLAGS coordinate. */
    static const pl_u8 neg_sbb_flag_chain[] = {
        0x48u, 0xc7u, 0xc2u, 0xc0u, 0x39u, 0x8du, 0x81u,
        0x48u, 0x89u, 0xdfu,
        0x83u, 0xe0u, 0x03u,
        0x66u, 0xf7u, 0xd8u,
        0x19u, 0xf6u,
        0x83u, 0xc6u, 0x02u,
    };
    /* Actual pure slice from corpus/crypto/bn_mul_mont.c between its load and
     * store cuts: SETB and ADD are independent; ADC joins both in wave two. */
    static const pl_u8 cios_carry_slice[] = {
        0x0fu, 0x92u, 0xc3u,
        0x49u, 0x01u, 0xc2u,
        0x48u, 0x11u, 0xd3u,
    };
    /* Byte* coordinate 0xffffffff815287b7 in the linked Linux image starts
     * inside a CALL displacement.  It is nevertheless a required x86 entry:
     * mask EAX, sign-extend the retained value into RBX, and branch on zero. */
    static const pl_u8 masked_sign_test_branch[] = {
        0x25u, 0x86u, 0xfbu, 0xffu, 0x48u,
        0x63u, 0xd8u,
        0x48u, 0x85u, 0xdbu,
        0x74u, 0x18u,
    };
    static const pl_u8 masked_sign_test_branch_result[] = {
        0x25u, 0x86u, 0xfbu, 0xffu, 0x48u,
        0x89u, 0xc3u,
        0x74u, 0x00u,
    };
    /* Required Byte* coordinate 0xffffffff81ae67b5 in Linux: its first and
     * fourth source operations form one SSA wave.  The XOR result is handed
     * from entry EAX to EDX before EAX receives the independent affine value;
     * the dead intermediate TEST never reaches the accepted future. */
    static const pl_u8 compare_handoff_branch[] = {
        0x35u, 0x75u, 0xffu, 0x6bu, 0x35u,
        0xa9u, 0xceu, 0xfdu, 0xffu, 0x18u,
        0x89u, 0xc2u,
        0x8du, 0x46u, 0x28u,
        0x39u, 0xc2u,
        0x0fu, 0x84u, 0x6eu, 0x01u, 0x00u, 0x00u,
    };
    /* Actual bn_mul_mont entry frame.  Final CMP remains necessary because
     * its complete RFLAGS word is a live successor publication.  What is not
     * necessary is the source allocation `R14=RSP; RAX=aligned; R14-=RAX;
     * RSP=R14`: R14 is dead on entry, so it can own the aligned RHS, update
     * RSP once, and receive the shared result afterward.  RAX then uses the
     * shorter XOR spelling because TEST redefines flags before CMOV. */
    static const pl_u8 aligned_subtract_handoff_branch[] = {
        0x45u, 0x89u, 0xcfu,
        0x41u, 0x83u, 0xc1u, 0x02u,
        0x49u, 0x89u, 0xe6u,
        0x4au, 0x8du, 0x04u, 0xfdu, 0x1fu, 0x00u, 0x00u, 0x00u,
        0x48u, 0x83u, 0xe0u, 0xf0u,
        0x49u, 0x29u, 0xc6u,
        0x4cu, 0x89u, 0xf4u,
        0x31u, 0xc0u,
        0x45u, 0x85u, 0xc9u,
        0x44u, 0x0fu, 0x4eu, 0xc8u,
        0x49u, 0x39u, 0xc1u,
        0x74u, 0x0au,
    };
    static const pl_u8 aligned_subtract_handoff_result[] = {
        0x45u, 0x89u, 0xcfu,
        0x4eu, 0x8du, 0x34u, 0xfdu, 0x1fu, 0x00u, 0x00u, 0x00u,
        0x49u, 0x83u, 0xe6u, 0xf0u,
        0x4cu, 0x29u, 0xf4u,
        0x49u, 0x89u, 0xe6u,
        0x31u, 0xc0u,
        0x45u, 0x8du, 0x49u, 0x02u,
        0x45u, 0x85u, 0xc9u,
        0x44u, 0x0fu, 0x4eu, 0xc8u,
        0x49u, 0x39u, 0xc1u,
        0x74u, 0x00u,
    };
    /* Required Byte* coordinate 0xffffffff812a433b in Linux 7.1.8 starts
     * inside the preceding LEA.  The three variable shifts all consume the
     * same entry CL.  Their intermediate flag words are dead before CMP, so
     * emit both CMP operands before the unrelated RSI publication; otherwise
     * the x86 count-zero flag chain adds a false sixth wave. */
    static const pl_u8 parallel_variable_shift_branch[] = {
        0x2cu, 0x2cu,
        0x4cu, 0x89u, 0xefu,
        0xbeu, 0x01u, 0x00u, 0x00u, 0x00u,
        0x48u, 0x8du, 0x45u, 0xffu,
        0x48u, 0xd3u, 0xefu,
        0x48u, 0xd3u, 0xe8u,
        0x48u, 0xd3u, 0xe6u,
        0x4cu, 0x89u, 0xe1u,
        0x48u, 0x39u, 0xc7u,
        0x74u, 0x13u,
    };
    static const pl_u8 parallel_variable_shift_result[] = {
        0x48u, 0x8du, 0x45u, 0xffu,
        0x48u, 0xd3u, 0xe8u,
        0xbeu, 0x01u, 0x00u, 0x00u, 0x00u,
        0x48u, 0xd3u, 0xe6u,
        0x4cu, 0x89u, 0xefu,
        0x48u, 0xd3u, 0xefu,
        0x48u, 0x39u, 0xc7u,
        0x4cu, 0x89u, 0xe1u,
        0x74u, 0x00u,
    };
    /* Required Byte* coordinate 0xffffffff81622cb8 in Linux 7.1.8.  The
     * source is already work-minimal, but serializes the final accumulator
     * through seven instructions.  In the complete four-leaf XOR future,
     * T=(RAX^RDX) and P=(RCX+T) each need one physical owner only.  Compute
     * the independent rotate arm before overwriting RCX, keep T in RDX and P
     * in RCX, then reassociate the leaves.  The exact ordinary-x86 result is
     * one byte smaller at the same 18 work and shortens span from 7 to 5. */
    static const pl_u8 arx_shared_dag_source[] = {
        0x48u, 0x31u, 0xc2u,
        0x48u, 0x89u, 0xf0u,
        0x48u, 0xc1u, 0xc0u, 0x10u,
        0x48u, 0x8du, 0x34u, 0x0au,
        0x48u, 0xc1u, 0xc2u, 0x11u,
        0x48u, 0x31u, 0xc8u,
        0x48u, 0xc1u, 0xc0u, 0x15u,
        0x48u, 0x31u, 0xf0u,
        0x48u, 0xc1u, 0xc6u, 0x20u,
        0x48u, 0x31u, 0xd0u,
        0x48u, 0x31u, 0xf0u,
        0x31u, 0xd2u,
        0x31u, 0xc9u,
        0x31u, 0xf6u,
        0x31u, 0xffu,
        0x45u, 0x31u, 0xc0u,
        0x45u, 0x31u, 0xc9u,
        0x45u, 0x31u, 0xd2u,
    };
    static const pl_u8 arx_shared_dag_result[] = {
        0x48u, 0xc1u, 0xc6u, 0x10u,
        0x48u, 0x31u, 0xceu,
        0x48u, 0xc1u, 0xc6u, 0x15u,
        0x48u, 0x31u, 0xc2u,
        0x48u, 0x01u, 0xd1u,
        0x48u, 0x89u, 0xc8u,
        0x48u, 0xc1u, 0xc0u, 0x20u,
        0x48u, 0xc1u, 0xc2u, 0x11u,
        0x48u, 0x31u, 0xcau,
        0x48u, 0x31u, 0xd6u,
        0x48u, 0x31u, 0xf0u,
        0x31u, 0xc9u,
        0x31u, 0xd2u,
        0x31u, 0xf6u,
        0x31u, 0xffu,
        0x45u, 0x31u, 0xc0u,
        0x45u, 0x31u, 0xc9u,
        0x45u, 0x31u, 0xd2u,
    };
    static const pl_u8 arx_shared_dag_low32_result[] = {
        0x48u, 0xc1u, 0xc6u, 0x10u,
        0x48u, 0x31u, 0xceu,
        0x48u, 0xc1u, 0xc6u, 0x15u,
        0x31u, 0xc2u,
        0x48u, 0x01u, 0xd1u,
        0x48u, 0x89u, 0xc8u,
        0x48u, 0xc1u, 0xc0u, 0x20u,
        0x48u, 0xc1u, 0xc2u, 0x11u,
        0x48u, 0x31u, 0xcau,
        0x48u, 0x31u, 0xd6u,
        0x48u, 0x31u, 0xf0u,
        0x31u, 0xc9u,
        0x31u, 0xd2u,
        0x31u, 0xf6u,
        0x31u, 0xffu,
        0x45u, 0x31u, 0xc0u,
        0x45u, 0x31u, 0xc9u,
        0x45u, 0x31u, 0xd2u,
    };
    static const pl_u8 mutable_xor_result[] = {
        0xc1u, 0xc2u, 0x11u,
        0x48u, 0x31u, 0xc8u,
        0x48u, 0xc1u, 0xc0u, 0x15u,
        0x48u, 0x31u, 0xf0u,
        0x48u, 0xc1u, 0xc6u, 0x20u,
        0x48u, 0x31u, 0xd6u,
        0x48u, 0x31u, 0xf0u,
        0x31u, 0xc9u,
        0x31u, 0xd2u,
        0x31u, 0xf6u,
        0x31u, 0xffu,
        0x45u, 0x31u, 0xc0u,
        0x45u, 0x31u, 0xc9u,
        0x45u, 0x31u, 0xd2u,
    };
    /* Required Byte* coordinate 0xffffffff81af6670 in Linux 7.1.8.  The
     * scaled address is already one LEA coordinate even though its canonical
     * ADD has a shifted node on the right.  The final ADD publishes RAX and
     * RFLAGS together; folding the constant before emission removes the
     * source MOV+SHL chain without splitting the flag/value producer. */
    static const pl_u8 recursive_affine_source[] = {
        0x4cu, 0x8du, 0x2cu, 0xc1u,
        0xb8u, 0x01u, 0x00u, 0x00u, 0x00u,
        0xb9u, 0x00u, 0x00u, 0x00u, 0x80u,
        0x48u, 0xc1u, 0xe0u, 0x27u,
        0x48u, 0x01u, 0xf0u,
    };
    static const pl_u8 recursive_affine_result[] = {
        0x4cu, 0x8du, 0x2cu, 0xc1u,
        0x48u, 0xb8u, 0x00u, 0x00u, 0x00u, 0x00u,
        0x80u, 0x00u, 0x00u, 0x00u,
        0x48u, 0x01u, 0xf0u,
        0xb9u, 0x00u, 0x00u, 0x00u, 0x80u,
    };
    /* Required Byte* coordinate 0xffffffff812e9ea1 in Linux 7.1.8.  SUB
     * replaces every arithmetic flag observed by the accepted future, so the
     * preceding CLC has no surviving publication.  DF and the remaining
     * control flags still pass through SUB independently. */
    static const pl_u8 overwritten_carry_source[] = {
        0xf8u,
        0x48u, 0x29u, 0xd8u,
        0x4cu, 0x8du, 0x1cu, 0xc2u,
        0x48u, 0x89u, 0xc1u,
        0xb8u, 0x01u, 0x00u, 0x00u, 0x00u,
    };
    static const pl_u8 overwritten_carry_result[] = {
        0x48u, 0x29u, 0xd8u,
        0x4cu, 0x8du, 0x1cu, 0xc2u,
        0x48u, 0x89u, 0xc1u,
        0xb8u, 0x01u, 0x00u, 0x00u, 0x00u,
    };
    /* Required Byte* coordinate 0xffffffff813a72a4 in Linux 7.1.8.  R14 and
     * RAX have the same scaled-RDX parent.  Keeping the scale inside both
     * addressing coordinates lets the two LEAs run in one wave after EDX;
     * materializing R14 and then consuming it adds a false third wave. */
    static const pl_u8 affine_fanout_source[] = {
        0x8du, 0x14u, 0x7fu,
        0x4cu, 0x8du, 0x34u, 0xd5u, 0x00u, 0x00u, 0x00u, 0x00u,
        0x4au, 0x8du, 0x04u, 0x36u,
    };
    static const pl_u8 affine_fanout_result[] = {
        0x8du, 0x14u, 0x7fu,
        0x4cu, 0x8du, 0x34u, 0xd5u, 0x00u, 0x00u, 0x00u, 0x00u,
        0x48u, 0x8du, 0x04u, 0xd6u,
    };
    /* Required Byte* coordinate 0xffffffff813e8bbc in Linux 7.1.8.  The
     * sign-extended parent is an ordinary affine source just like a native
     * 32-bit publication: R10 and R9 consume it independently with scale 8. */
    static const pl_u8 signed_affine_fanout_source[] = {
        0x48u, 0xb8u, 0xffu, 0xffu, 0xffu, 0xffu, 0xffu, 0xffu, 0x3fu, 0x00u,
        0x48u, 0x63u, 0xf3u,
        0x4cu, 0x8du, 0x14u, 0xf5u, 0x00u, 0x00u, 0x00u, 0x00u,
        0x4fu, 0x8du, 0x0cu, 0x10u,
    };
    static const pl_u8 signed_affine_fanout_result[] = {
        0x48u, 0xb8u, 0xffu, 0xffu, 0xffu, 0xffu, 0xffu, 0xffu, 0x3fu, 0x00u,
        0x48u, 0x63u, 0xf3u,
        0x4cu, 0x8du, 0x14u, 0xf5u, 0x00u, 0x00u, 0x00u, 0x00u,
        0x4du, 0x8du, 0x0cu, 0xf0u,
    };
    /* Required Byte* coordinate 0xffffffff812015c4 in Linux 7.1.8.  The
     * successor observes RSI and the branch outcome, not a materialized
     * compare record.  The immediate predicate and the independent constant
     * publication therefore form two waves and exactly three coordinates. */
    static const pl_u8 immediate_compare_branch_source[] = {
        0x48u, 0xc7u, 0xc6u, 0x81u, 0xcdu, 0x8cu, 0x81u,
        0x49u, 0x83u, 0xfeu, 0xffu,
        0x74u, 0x60u,
    };
    static const pl_u8 immediate_compare_branch_result[] = {
        0x49u, 0x83u, 0xfeu, 0xffu,
        0x48u, 0xc7u, 0xc6u, 0x81u, 0xcdu, 0x8cu, 0x81u,
        0x74u, 0x00u,
    };
    /* Required Byte* coordinate 0xffffffff8120176d in Linux 7.1.8.  JNE
     * consumes entry RFLAGS, while RSI and RCX are independent leaf
     * publications.  Reordering the leaves exposes their one-wave schedule;
     * no decoded source-order row is retained in the selected body. */
    static const pl_u8 entry_flag_branch_source[] = {
        0x48u, 0xc7u, 0xc6u, 0x7cu, 0xcdu, 0x8cu, 0x81u,
        0x48u, 0x89u, 0xd1u,
        0x75u, 0x07u,
    };
    static const pl_u8 entry_flag_branch_result[] = {
        0x48u, 0x89u, 0xd1u,
        0x48u, 0xc7u, 0xc6u, 0x7cu, 0xcdu, 0x8cu, 0x81u,
        0x75u, 0x00u,
    };
    /* Required Byte* coordinate 0xffffffff81201a5d in Linux 7.1.8.  EDX
     * captures the low entry ESI generation before ESI is shifted.  The AND
     * then publishes both the final EDX value and the only surviving flag
     * word; the unrelated address constant is a parallel leaf publication. */
    static const pl_u8 zero_extend_generation_source[] = {
        0x89u, 0xf2u,
        0x48u, 0xc7u, 0xc7u, 0xdfu, 0xd1u, 0x8cu, 0x81u,
        0xc1u, 0xeeu, 0x05u,
        0x83u, 0xe2u, 0x1fu,
    };
    static const pl_u8 zero_extend_generation_result[] = {
        0x89u, 0xf2u,
        0xc1u, 0xeeu, 0x05u,
        0x83u, 0xe2u, 0x1fu,
        0x48u, 0xc7u, 0xc7u, 0xdfu, 0xd1u, 0x8cu, 0x81u,
    };
    /* Required Byte* coordinate 0xffffffff81201b47 in Linux 7.1.8.  The
     * byte TEST is the final flag publication for a 64-bit conditional
     * constant.  Publish both value arms and the independent leaves first,
     * then TEST+CMOV as one two-wave normalized schedule. */
    static const pl_u8 byte_test_select_source[] = {
        0x45u, 0x84u, 0xedu,
        0x48u, 0xc7u, 0xc6u, 0xb7u, 0xd1u, 0x8cu, 0x81u,
        0x4cu, 0x89u, 0xf2u,
        0x48u, 0xc7u, 0xc0u, 0xaeu, 0xd1u, 0x8cu, 0x81u,
        0x48u, 0x0fu, 0x45u, 0xf0u,
        0x48u, 0xc7u, 0xc7u, 0xf0u, 0xd1u, 0x8cu, 0x81u,
    };
    static const pl_u8 byte_test_select_result[] = {
        0x48u, 0xc7u, 0xc0u, 0xaeu, 0xd1u, 0x8cu, 0x81u,
        0x4cu, 0x89u, 0xf2u,
        0x48u, 0xc7u, 0xc6u, 0xb7u, 0xd1u, 0x8cu, 0x81u,
        0x45u, 0x84u, 0xedu,
        0x48u, 0x0fu, 0x45u, 0xf0u,
        0x48u, 0xc7u, 0xc7u, 0xf0u, 0xd1u, 0x8cu, 0x81u,
    };
    /* Required Byte* coordinate 0xffffffff81202128 in Linux 7.1.8.  ECX
     * and EDX retain old entry words before ESI becomes the unique zero and
     * final flag owner.  The normalized short jump is independent of the
     * linked source distance. */
    static const pl_u8 zero_flag_entry_copy_source[] = {
        0x89u, 0xf1u,
        0x89u, 0xfau,
        0x31u, 0xf6u,
        0x48u, 0xc7u, 0xc7u, 0x18u, 0x4bu, 0x8bu, 0x81u,
        0xe9u, 0xd6u, 0x45u, 0x00u, 0x00u,
    };
    static const pl_u8 zero_flag_entry_copy_result[] = {
        0x89u, 0xf1u,
        0x89u, 0xfau,
        0x31u, 0xf6u,
        0x48u, 0xc7u, 0xc7u, 0x18u, 0x4bu, 0x8bu, 0x81u,
        0xebu, 0x00u,
    };
    /* A RIP-relative address remains 64-bit after the PIE load bias is
     * applied.  A short MOV EDX,ECX would discard the upper half even when
     * the link-time target happens to fit in 32 bits. */
    static const pl_u8 zero_flag_address_copy_source[] = {
        0x48u, 0x8du, 0x0du, 0x00u, 0x01u, 0x00u, 0x00u,
        0x31u, 0xc0u,
        0x48u, 0x89u, 0xcau,
        0xebu, 0x00u,
    };
    /* OpenSSL's CPU-feature branch chooses between two static descriptors.
     * Their link-time offsets are small, but their runtime PIE addresses are
     * not 32-bit values. */
    static const pl_u8 address_select_source[] = {
        0x48u, 0x8du, 0x15u, 0x92u, 0x96u, 0x34u, 0x00u,
        0x48u, 0x8du, 0x05u, 0x4bu, 0x95u, 0x34u, 0x00u,
        0x48u, 0x0fu, 0x45u, 0xc2u,
    };
    /* ld_stop_phase publishes phase_data in RAX before adding it to RBX.
     * If the 64-bit ADD uses RAX instead of an immediate, its publication
     * must precede the ADD even though the SSA operand is a constant. */
    static const pl_u8 published_address_add_source[] = {
        0x48u, 0x8du, 0x1cu, 0xc0u,
        0x48u, 0x8du, 0x05u, 0x9fu, 0xd4u, 0x28u, 0x00u,
        0x48u, 0xc1u, 0xe3u, 0x06u,
        0x48u, 0x01u, 0xc3u,
        0x48u, 0x81u, 0xecu, 0x20u, 0x01u, 0x00u, 0x00u,
    };
    /* A second LEA derived from a RIP-relative address still carries the
     * load bias.  Replacing it with MOV ECX,0x28d8c0 loses that bias. */
    static const pl_u8 derived_address_source[] = {
        0x48u, 0x8du, 0x15u, 0x3au, 0x08u, 0x22u, 0x00u,
        0x48u, 0x8du, 0x4au, 0x90u,
        0xebu, 0x2au,
    };
    /* alloc_slot shifts EDX with the entry CL, then replaces ECX from R8D
     * for the independent EAX shift.  The two counts are not interchangeable. */
    static const pl_u8 entry_shift_count_source[] = {
        0x41u, 0x83u, 0xeau, 0x01u,
        0x83u, 0xe5u, 0x3fu,
        0xd3u, 0xe2u,
        0x44u, 0x89u, 0xc1u,
        0x41u, 0x83u, 0xe2u, 0x1fu,
        0xc1u, 0xe5u, 0x06u,
        0x83u, 0xeau, 0x01u,
        0xd3u, 0xe0u,
        0x41u, 0x83u, 0xcau, 0x20u,
    };
    /* The GCC allocator forms a bitmap mask from the entry CL. Moving the
     * constant into RCX before the shift would replace that count with 1. */
    static const pl_u8 shift_count_same_register_source[] = {
        0x41u, 0xb8u, 0x01u, 0x00u, 0x00u, 0x00u, /* mov r8d, 1 */
        0x48u, 0x0fu, 0xafu, 0xd5u,               /* imul rdx, rbp */
        0x49u, 0xd3u, 0xe0u,                      /* shl r8, cl */
        0x4cu, 0x89u, 0xc1u,                      /* mov rcx, r8 */
        0xebu, 0x00u,                            /* jmp next */
    };
    /* A 32-bit index may feed a 64-bit stack address. Folding the two LEAs
     * is legal, but writing EDI would discard the stack pointer's high half. */
    static const pl_u8 wide_indexed_address_source[] = {
        0x8du, 0x51u, 0xffu,                      /* lea edx, [rcx-1] */
        0x48u, 0x8du, 0x7cu, 0x15u, 0x05u,       /* lea rdi, [rbp+rdx+5] */
        0xebu, 0x00u,
    };
    /* Required Byte* coordinate 0xffffffff81202179 in Linux 7.1.8.  EDX is
     * the low word of the already-published shifted RBP node.  It therefore
     * reads EBP directly instead of rebuilding that shift subtree. */
    static const pl_u8 published_zero_extend_source[] = {
        0x89u, 0xeeu,
        0x48u, 0xc1u, 0xedu, 0x20u,
        0xbfu, 0x10u, 0x00u, 0x01u, 0xc0u,
        0x81u, 0xe6u, 0xffu, 0xffu, 0xf7u, 0xffu,
        0x89u, 0xeau,
    };
    static const pl_u8 published_zero_extend_result[] = {
        0x89u, 0xeeu,
        0x48u, 0xc1u, 0xedu, 0x20u,
        0x89u, 0xeau,
        0x81u, 0xe6u, 0xffu, 0xffu, 0xf7u, 0xffu,
        0xbfu, 0x10u, 0x00u, 0x01u, 0xc0u,
    };
    /* Required Byte* coordinate 0xffffffff8120248d in Linux 7.1.8.  EDX>>4
     * is the sole residual state shared by the EDX and ECX masks.  EAX first
     * consumes the old EDX generation; the shifted generation is then formed
     * once, copied once, and both masks join under the final flag-producing
     * OR.  The source's duplicate shifts and byte insertion are absent. */
    static const pl_u8 shared_shift_mask_source[] = {
        0x89u, 0xd1u,
        0x89u, 0xd0u,
        0xc1u, 0xe9u, 0x08u,
        0xc1u, 0xe8u, 0x08u,
        0x83u, 0xe1u, 0x0fu,
        0x25u, 0xf0u, 0x00u, 0x00u, 0x00u,
        0x80u, 0xcdu, 0x0fu,
        0x09u, 0xc8u,
        0x89u, 0xd1u,
        0xc1u, 0xeau, 0x18u,
        0xc1u, 0xe9u, 0x04u,
        0xc1u, 0xe2u, 0x14u,
        0x81u, 0xe1u, 0x00u, 0x00u, 0x0fu, 0x00u,
        0x09u, 0xc8u,
        0x09u, 0xd0u,
    };
    static const pl_u8 shared_shift_mask_result[] = {
        0x89u, 0xd0u,
        0xc1u, 0xe8u, 0x08u,
        0x25u, 0xffu, 0x00u, 0x00u, 0x00u,
        0x0du, 0x00u, 0x0fu, 0x00u, 0x00u,
        0xc1u, 0xeau, 0x04u,
        0x89u, 0xd1u,
        0x81u, 0xe2u, 0x00u, 0x00u, 0xf0u, 0xffu,
        0x81u, 0xe1u, 0x00u, 0x00u, 0x0fu, 0x00u,
        0x09u, 0xc8u,
        0x09u, 0xd0u,
    };
    /* A wide shift feeds a narrower flag-producing AND.  The shift must keep
     * its own width even though the consumer only publishes a 32-bit value.
     * Independent constants and copies do not require another flag owner.
     * Linux block 0xffffffff81202909..0xffffffff8120292e remains 8 work /
     * 3 span / 37 bytes, now covered by the normalized native production. */
    /* Select an address or the entry RDX, then publish a new RDX. The CMOV
     * must consume the entry value before MOV EDX replaces that coordinate.
     * lea rax,[rip+0x4e726]; cmove rax,rdx; mov edx,4 */
    static const pl_u8 conditional_address_handoff_source[] = {
        0x48u, 0x8du, 0x05u, 0x26u, 0xe7u, 0x04u, 0x00u,
        0x48u, 0x0fu, 0x44u, 0xc2u,
        0xbau, 0x04u, 0x00u, 0x00u, 0x00u,
    };
    /* Decimal accumulation with a low-word subtraction, signed widening and
     * a shared multiply publication, followed by unsigned overflow control.
     * mov rcx,rdx; sub eax,48; imul rcx,rsi; cdqe;
     * add rax,rcx; cmp rax,rsi; jb +65 */
    static const pl_u8 signed_digit_accumulation_source[] = {
        0x48u, 0x89u, 0xd1u, 0x83u, 0xe8u, 0x30u,
        0x48u, 0x0fu, 0xafu, 0xceu, 0x48u, 0x98u,
        0x48u, 0x01u, 0xc8u, 0x48u, 0x39u, 0xf0u, 0x72u, 0x41u,
    };
    /* A shared aligned stack pointer must be copied, not recomputed. Both
     * affine leaves can consume the old RAX before its next generation:
     * rbx=rdx+rax; rax=(rdx+rax+26)&-16; rsp-=rax;
     * r10=(rsp+15)&-16; r12=r10; cmp r10,rcx; jae target. */
    static const pl_u8 aligned_stack_fanout_source[] = {
        0x48u, 0x8du, 0x1cu, 0x02u, 0x48u, 0x8du, 0x43u, 0x1au,
        0x48u, 0x83u, 0xe0u, 0xf0u, 0x48u, 0x29u, 0xc4u,
        0x4cu, 0x8du, 0x54u, 0x24u, 0x0fu, 0x49u, 0x83u, 0xe2u, 0xf0u,
        0x49u, 0x39u, 0xcau, 0x4du, 0x89u, 0xd4u,
        0x0fu, 0x83u, 0xd9u, 0x04u, 0x00u, 0x00u,
    };
    static const pl_u8 wide_shift_narrow_flags_source[] = {
        0x4cu, 0x89u, 0xf9u,
        0x48u, 0xc7u, 0xc2u, 0xa6u, 0xeeu, 0x8cu, 0x81u,
        0x4du, 0x89u, 0xf8u,
        0x48u, 0x89u, 0xeeu,
        0x48u, 0xc1u, 0xe9u, 0x31u,
        0x48u, 0xc7u, 0xc0u, 0x9du, 0xeeu, 0x8cu, 0x81u,
        0x48u, 0xc7u, 0xc7u, 0x80u, 0x68u, 0x8bu, 0x81u,
        0x83u, 0xe1u, 0x7fu,
    };
    /* Required Byte* coordinate 0xffffffff8120284b in Linux 7.1.8.  The
     * normalized low byte of RAX>>8 is already the architectural AH
     * coordinate, so MOVZX EAX,AH publishes it directly.  No shifted scalar
     * or temporary register is materialized; the remaining entry consumers
     * are scheduled before the EAX overwrite and the SHR EDX publication
     * remains the final RFLAGS owner. */
    static const pl_u8 high8_projection_source[] = {
        0x48u, 0xc7u, 0xc7u, 0xfeu, 0xd7u, 0x8cu, 0x81u,
        0x49u, 0xc7u, 0xc1u, 0x8eu, 0xeeu, 0x8cu, 0x81u,
        0x49u, 0xc7u, 0xc0u, 0xddu, 0xd5u, 0x8cu, 0x81u,
        0x48u, 0x89u, 0xc1u,
        0x48u, 0x89u, 0xc2u,
        0x49u, 0x89u, 0xc7u,
        0x0fu, 0xb6u, 0xf0u,
        0x48u, 0xc1u, 0xe9u, 0x0cu,
        0x48u, 0xc1u, 0xeau, 0x0eu,
        0x0fu, 0xb6u, 0xc4u,
    };
    static const pl_u8 high8_projection_result[] = {
        0x48u, 0xc7u, 0xc7u, 0xfeu, 0xd7u, 0x8cu, 0x81u,
        0x49u, 0xc7u, 0xc0u, 0xddu, 0xd5u, 0x8cu, 0x81u,
        0x49u, 0xc7u, 0xc1u, 0x8eu, 0xeeu, 0x8cu, 0x81u,
        0x49u, 0x89u, 0xc7u,
        0x48u, 0x89u, 0xc1u,
        0x48u, 0xc1u, 0xe9u, 0x0cu,
        0x48u, 0x89u, 0xc2u,
        0x48u, 0xc1u, 0xeau, 0x0eu,
        0x0fu, 0xb6u, 0xf0u,
        0x0fu, 0xb6u, 0xc4u,
    };
    /* Linux 7.1.8 x86-64 code at 0xffffffff8122799a.  The low word of
     * IMUL is multiplication modulo 2^64, hence IMUL RAX,RSI,1<<20 is
     * exactly RAX=RSI<<20 while preserving RSI.  It replaces MOV+SHL with
     * one instruction; the following AND makes only source bit 5 observable.
     * This yields one spelling that simultaneously attains the minimum work
     * and span instead of retaining separate 14/7 and 15/6 candidates. */
    static const pl_u8 shifted_copy_overlay_source[] = {
        0x48u, 0x81u, 0xcau, 0x00u, 0x00u, 0x00u, 0x50u,
        0x40u, 0xf6u, 0xc6u, 0x10u,
        0x48u, 0x0fu, 0x44u, 0xd0u,
        0x48u, 0x89u, 0xf0u,
        0x48u, 0xc1u, 0xe0u, 0x14u,
        0x25u, 0x00u, 0x00u, 0x00u, 0x02u,
        0x48u, 0x09u, 0xd0u,
        0x48u, 0x0fu, 0xbau, 0xe8u, 0x28u,
        0x48u, 0x83u, 0xe0u, 0xe0u,
        0x48u, 0x83u, 0xc8u, 0x04u,
        0x31u, 0xd2u,
        0x31u, 0xc9u,
        0x31u, 0xf6u,
        0x31u, 0xffu,
    };
    static const pl_u8 shifted_copy_overlay_result[] = {
        0x48u, 0xb9u, 0x04u, 0x00u, 0x00u, 0x00u,
        0x00u, 0x01u, 0x00u, 0x00u,
        0x48u, 0x81u, 0xcau, 0x00u, 0x00u, 0x00u, 0x50u,
        0x40u, 0xf6u, 0xc6u, 0x10u,
        0x48u, 0x0fu, 0x44u, 0xd0u,
        0x48u, 0x69u, 0xc6u, 0x00u, 0x00u, 0x10u, 0x00u,
        0x25u, 0x00u, 0x00u, 0x00u, 0x02u,
        0x48u, 0x09u, 0xd0u,
        0x48u, 0xbau, 0xe0u, 0xffu, 0xffu, 0xffu,
        0xffu, 0xfeu, 0xffu, 0xffu,
        0x48u, 0x21u, 0xd0u,
        0x48u, 0x09u, 0xc8u,
        0x31u, 0xffu,
        0x89u, 0xf9u,
        0x89u, 0xfau,
        0x89u, 0xfeu,
    };
    /* The same Linux sequence entered at 0xffffffff812279a5 observes entry
     * RFLAGS.  RAX already contains SELECT's true arm, so CMOVNE RAX,RDX
     * consumes that flag word before IMUL or AND can overwrite it.  No
     * temporary copy of either SELECT arm is required. */
    static const pl_u8 entry_select_overlay_source[] = {
        0x48u, 0x0fu, 0x44u, 0xd0u,
        0x48u, 0x89u, 0xf0u,
        0x48u, 0xc1u, 0xe0u, 0x14u,
        0x25u, 0x00u, 0x00u, 0x00u, 0x02u,
        0x48u, 0x09u, 0xd0u,
        0x48u, 0x0fu, 0xbau, 0xe8u, 0x28u,
        0x48u, 0x83u, 0xe0u, 0xe0u,
        0x48u, 0x83u, 0xc8u, 0x04u,
        0x31u, 0xd2u,
        0x31u, 0xc9u,
        0x31u, 0xf6u,
        0x31u, 0xffu,
    };
    static const pl_u8 entry_select_overlay_result[] = {
        0x48u, 0x0fu, 0x45u, 0xc2u,
        0x48u, 0xc1u, 0xe6u, 0x14u,
        0x81u, 0xe6u, 0x00u, 0x00u, 0x00u, 0x02u,
        0x48u, 0x09u, 0xf0u,
        0x48u, 0xb9u, 0xe0u, 0xffu, 0xffu, 0xffu,
        0xffu, 0xfeu, 0xffu, 0xffu,
        0x48u, 0x21u, 0xc8u,
        0x48u, 0xb9u, 0x04u, 0x00u, 0x00u, 0x00u,
        0x00u, 0x01u, 0x00u, 0x00u,
        0x48u, 0x09u, 0xc8u,
        0x31u, 0xffu,
        0x89u, 0xf9u,
        0x89u, 0xfau,
        0x89u, 0xfeu,
    };
    /* Entering at 0xffffffff812279a9 leaves a pure entry-word overlay.
     * Since the shifted RSI arm is explicitly bounded to bit 25, it passes
     * through the outer mask unchanged.  RDX receives its forced bits while
     * RCX forms that arm independently; one final OR joins them. */
    static const pl_u8 parallel_entry_overlay_source[] = {
        0x48u, 0x89u, 0xf0u,
        0x48u, 0xc1u, 0xe0u, 0x14u,
        0x25u, 0x00u, 0x00u, 0x00u, 0x02u,
        0x48u, 0x09u, 0xd0u,
        0x48u, 0x0fu, 0xbau, 0xe8u, 0x28u,
        0x48u, 0x83u, 0xe0u, 0xe0u,
        0x48u, 0x83u, 0xc8u, 0x04u,
        0x31u, 0xd2u,
        0x31u, 0xc9u,
        0x31u, 0xf6u,
        0x31u, 0xffu,
    };
    static const pl_u8 parallel_entry_overlay_result[] = {
        0x48u, 0x0fu, 0xbau, 0xeau, 0x28u,
        0x80u, 0xcau, 0x04u,
        0x48u, 0x83u, 0xe2u, 0xe4u,
        0x48u, 0x69u, 0xceu, 0x00u, 0x00u, 0x10u, 0x00u,
        0x81u, 0xe1u, 0x00u, 0x00u, 0x00u, 0x02u,
        0x48u, 0x09u, 0xcau,
        0x48u, 0x89u, 0xd0u,
        0x31u, 0xffu,
        0x89u, 0xf9u,
        0x89u, 0xfau,
        0x89u, 0xfeu,
    };
    /* At 0xffffffff812279b5 both OR arms are disposable entry owners.  Split
     * forced bits 40 and 2 across them, join once, then apply the encodable
     * mask -28.  The two force instructions occupy the same dependency
     * wave, so the exact eight-work result has span three. The dead-flag OR
     * uses AL's two-byte immediate form, so bit 2 stays on RAX and bit 40
     * moves to RDX. The final AND, not that byte OR, owns the live flags. */
    static const pl_u8 split_entry_overlay_source[] = {
        0x48u, 0x09u, 0xd0u,
        0x48u, 0x0fu, 0xbau, 0xe8u, 0x28u,
        0x48u, 0x83u, 0xe0u, 0xe0u,
        0x48u, 0x83u, 0xc8u, 0x04u,
        0x31u, 0xd2u,
        0x31u, 0xc9u,
        0x31u, 0xf6u,
        0x31u, 0xffu,
    };
    static const pl_u8 split_entry_overlay_result[] = {
        0x0cu, 0x04u,
        0x48u, 0x0fu, 0xbau, 0xeau, 0x28u,
        0x48u, 0x09u, 0xd0u,
        0x48u, 0x83u, 0xe0u, 0xe4u,
        0x31u, 0xffu,
        0x89u, 0xf9u,
        0x89u, 0xfau,
        0x89u, 0xfeu,
    };
    /* Entering the same Linux sequence at 0xffffffff812279b6 makes the
     * initial OR a 32-bit operation.  Its architectural zero-extension makes
     * every high bit of the following 64-bit mask unobservable.  Mask EAX,
     * form the high constant independently in the consumed RDX owner, then
     * join once.  This attains eight work and span three simultaneously. */
    static const pl_u8 low32_entry_overlay_source[] = {
        0x09u, 0xd0u,
        0x48u, 0x0fu, 0xbau, 0xe8u, 0x28u,
        0x48u, 0x83u, 0xe0u, 0xe0u,
        0x48u, 0x83u, 0xc8u, 0x04u,
        0x31u, 0xd2u,
        0x31u, 0xc9u,
        0x31u, 0xf6u,
        0x31u, 0xffu,
    };
    static const pl_u8 low32_entry_overlay_result[] = {
        0x09u, 0xd0u,
        0x83u, 0xe0u, 0xe0u,
        0x48u, 0xbau, 0x04u, 0x00u, 0x00u, 0x00u,
        0x00u, 0x01u, 0x00u, 0x00u,
        0x48u, 0x09u, 0xd0u,
        0x31u, 0xffu,
        0x89u, 0xf9u,
        0x89u, 0xfau,
        0x89u, 0xfeu,
    };
    /* Linux Byte* entry 0xffffffff8131b978 reaches a 32-bit XCHG followed
     * by an 8-bit AND.  Copying ESP into EAX first preserves the required
     * zero-extension; AND AL produces the exact byte-width flags while the
     * independent final ESP constant shares its wave. */
    static const pl_u8 narrow_flag_transfer_source[] = {
        0xb8u, 0x00u, 0x00u, 0x00u, 0x89u,
        0x94u,
        0x24u, 0xb4u,
    };
    static const pl_u8 narrow_flag_transfer_result[] = {
        0x89u, 0xe0u,
        0x24u, 0xb4u,
        0xbcu, 0x00u, 0x00u, 0x00u, 0x89u,
    };
    /* Linux Byte* entry 0xffffffff81341b19 has two consumers of entry RAX.
     * MOV captures it for the independent OR while CMOV consumes entry ZF;
     * both suffixes then share wave two.  TEST AH is the exact final RFLAGS
     * producer and may not be replaced by BTS or an entry flag word. */
    static const pl_u8 entry_select_bit_test[] = {
        0x89u, 0xc2u,
        0x48u, 0x0fu, 0x45u, 0xc1u,
        0x83u, 0xcau, 0x02u,
        0xf6u, 0xc4u, 0x02u,
    };
    /* Linux block 0xffffffff814501df publishes two projections of the new
     * R8 generation.  RBX is free after EAX consumes its entry value, so it
     * can hold the shifted R11 nibble and then directly become the second R8
     * projection.  Constructing that projection on R9 and copying it back
     * pins R9, repeats the R8 copy, and costs one extra instruction. */
    static const pl_u8 destination_reuse_source[] = {
        0x09u, 0xd8u,
        0x44u, 0x89u, 0xdbu,
        0x41u, 0x83u, 0xe3u, 0x0fu,
        0xc1u, 0xe3u, 0x0du,
        0x81u, 0xe3u, 0x00u, 0x00u, 0x1eu, 0x00u,
        0x41u, 0x09u, 0xd8u,
        0x45u, 0x29u, 0xc8u,
        0x45u, 0x89u, 0xc1u,
        0x44u, 0x89u, 0xc3u,
        0x41u, 0xc1u, 0xe9u, 0x08u,
        0xc1u, 0xebu, 0x07u,
        0x41u, 0x83u, 0xe1u, 0xf0u,
        0x83u, 0xe3u, 0x10u,
        0x45u, 0x09u, 0xd9u,
    };
    static const pl_u8 destination_reuse_result[] = {
        0x09u, 0xd8u,
        0x41u, 0x69u, 0xdbu, 0x00u, 0x20u, 0x00u, 0x00u,
        0x81u, 0xe3u, 0x00u, 0x00u, 0x1eu, 0x00u,
        0x41u, 0x09u, 0xd8u,
        0x45u, 0x29u, 0xc8u,
        0x44u, 0x89u, 0xc3u,
        0xc1u, 0xebu, 0x07u,
        0x83u, 0xe3u, 0x10u,
        0x41u, 0x83u, 0xe3u, 0x0fu,
        0x45u, 0x89u, 0xc1u,
        0x41u, 0xc1u, 0xe9u, 0x08u,
        0x41u, 0x83u, 0xe1u, 0xf0u,
        0x45u, 0x09u, 0xd9u,
    };
    /* Linux block 0xffffffff8147561e is one associative reduction with four
     * independently available arms.  Flattening all arms onto EAX adds a
     * fifth dependency wave.  Keeping the RCX/R9/R10 and R8 subtrees on
     * separate consumed owners, then joining them once into EAX, preserves
     * span four while retaining the one-work reduction. */
    static const pl_u8 balanced_reduction_source[] = {
        0xc1u, 0xe1u, 0x03u,
        0x41u, 0xc1u, 0xe0u, 0x02u,
        0x01u, 0xd2u,
        0x45u, 0x09u, 0xd1u,
        0x41u, 0x09u, 0xc9u,
        0x44u, 0x89u, 0xc8u,
        0x44u, 0x09u, 0xc0u,
        0x09u, 0xd0u,
        0x31u, 0xd2u,
        0x31u, 0xc9u,
        0x31u, 0xf6u,
        0x31u, 0xffu,
        0x45u, 0x31u, 0xc0u,
        0x45u, 0x31u, 0xc9u,
        0x45u, 0x31u, 0xd2u,
        0x45u, 0x31u, 0xdbu,
    };
    static const pl_u8 balanced_reduction_result[] = {
        0x8du, 0x04u, 0x12u,
        0xc1u, 0xe1u, 0x03u,
        0x45u, 0x09u, 0xd1u,
        0x44u, 0x09u, 0xc9u,
        0x41u, 0xc1u, 0xe0u, 0x02u,
        0x44u, 0x09u, 0xc1u,
        0x09u, 0xc8u,
        0x31u, 0xc9u,
        0x31u, 0xd2u,
        0x31u, 0xf6u,
        0x31u, 0xffu,
        0x45u, 0x31u, 0xdbu,
        0x45u, 0x89u, 0xd8u,
        0x45u, 0x89u, 0xd9u,
        0x45u, 0x89u, 0xdau,
    };
    /* Linux block 0xffffffff8162699d publishes
     * (R9 & 0xffffffffffff0000) | 8 to RDX, then discards R9.  The mask and
     * constant have disjoint support, so destructive AND on R9 followed by
     * LEA RDX,[R9+8] is the exact two-wave form; MOV/AND/BTS is unnecessary. */
    static const pl_u8 masked_entry_affine_source[] = {
        0x28u, 0xc9u,
        0x41u, 0xb1u, 0x08u,
        0x4cu, 0x89u, 0xc8u,
        0x88u, 0xccu,
        0x49u, 0x89u, 0xc1u,
        0x4cu, 0x89u, 0xc0u,
        0x4cu, 0x89u, 0xcau,
        0x31u, 0xc9u,
        0x31u, 0xf6u,
        0x31u, 0xffu,
        0x45u, 0x31u, 0xc0u,
        0x45u, 0x31u, 0xc9u,
        0x45u, 0x31u, 0xd2u,
    };
    static const pl_u8 masked_entry_affine_result[] = {
        0x4cu, 0x89u, 0xc0u,
        0x31u, 0xc9u,
        0x49u, 0x81u, 0xe1u, 0x00u, 0x00u, 0xffu, 0xffu,
        0x49u, 0x8du, 0x51u, 0x08u,
        0x31u, 0xf6u,
        0x31u, 0xffu,
        0x45u, 0x31u, 0xd2u,
        0x45u, 0x89u, 0xd0u,
        0x45u, 0x89u, 0xd1u,
    };
    /* BusyBox's aligned stack reservation has one shared subtraction result
     * in RSP and R14. Compute the aligned count once, subtract independently,
     * and let the final RSP subtraction publish the exact flags. The generic
     * frame's restore MOV made the independent work/span minima disagree. */
    static const pl_u8 shared_sub_source[] = {
        0xffu, 0xc0u,
        0x48u, 0x83u, 0xc0u, 0x0fu,
        0x48u, 0xc1u, 0xe8u, 0x04u,
        0x48u, 0xc1u, 0xe0u, 0x04u,
        0x48u, 0x29u, 0xc4u,
        0x49u, 0x89u, 0xe6u,
    };
    static const pl_u8 shared_sub_result[] = {
        0x49u, 0x89u, 0xe6u,
        0x8du, 0x40u, 0x01u,
        0x48u, 0x83u, 0xc0u, 0x0fu,
        0x48u, 0x83u, 0xe0u, 0xf0u,
        0x49u, 0x29u, 0xc6u,
        0x48u, 0x29u, 0xc4u,
    };
    /* Required Byte* coordinate 0xffffffff815641f9 in Linux 7.1.8.  STC is
     * dead before SAR/TEST.  RDX receives the entry RDI value, but the TEST
     * can still read unchanged RDI directly; testing the new RDX owner would
     * manufacture one dependency wave before CMOVG. */
    static const pl_u8 stable_predicate_source_jump[] = {
        0xf9u,
        0x48u, 0x89u, 0xfau,
        0x48u, 0xc1u, 0xf9u, 0x03u,
        0x48u, 0x85u, 0xffu,
        0x48u, 0x0fu, 0x4fu, 0xd1u,
        0xe9u, 0x4fu, 0xfeu, 0xffu, 0xffu,
    };
    static const pl_u8 stable_predicate_source_result[] = {
        0x48u, 0xc1u, 0xf9u, 0x03u,
        0x48u, 0x89u, 0xfau,
        0x48u, 0x85u, 0xffu,
        0x48u, 0x0fu, 0x4fu, 0xd1u,
        0xebu, 0x00u,
    };
    pl_u8 long_source_block[65u * 4u + 1u];
    for (pl_u32 index = 0u; index < 65u; ++index) {
        long_source_block[index * 4u + 0u] = 0x48u;
        long_source_block[index * 4u + 1u] = 0x83u;
        long_source_block[index * 4u + 2u] = 0xc0u;
        long_source_block[index * 4u + 3u] = 0x01u;
    }
    long_source_block[65u * 4u] = 0xc3u;
    pl_u8 aligned_negation[60u];
    aligned_negation[0] = 0xf7u;
    aligned_negation[1] = 0xdeu;
    for (pl_u32 index = 2u; index < sizeof aligned_negation; ++index)
        aligned_negation[index] = 0x90u;
    pl_u8 output[SELECT_OUTPUT_CAPACITY] = { 0u };
    pl_u32 written = 0u;
    pl_x86_native_selection selected;
    int status = joint_minimum_contract();
    if (status) {
        fprintf(stderr,
                "native x86 selection: RED (joint Pareto contract)\n");
        return 18;
    }
    /* A segment-base publication followed by a jump has two observable
     * operations even though its pure SSA plan has no node. Reconstruct both
     * from the architectural state and control shell, not copied code. */
    static const pl_u8 fs_base_jump[] = {
        0xf3u, 0x48u, 0x0fu, 0xaeu, 0xd2u,
        0xe9u, 0xf6u, 0xffu, 0xffu, 0xffu,
    };
    static const pl_u8 fs_base_jump_result[] = {
        0xf3u, 0x48u, 0x0fu, 0xaeu, 0xd2u, 0xebu, 0x00u,
    };
    status = select(fs_base_jump, sizeof fs_base_jump, 0x1000u,
                    &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present || !selected.direct_frame
            || selected.output_work != 2u || selected.output_span != 2u
            || written != sizeof fs_base_jump_result
            || memcmp(output, fs_base_jump_result,
                      sizeof fs_base_jump_result)) {
        fprintf(stderr,
                "native x86 selection: RED (segment-base state transfer "
                "status=%d source/normalized/direct=%u/%u/%u "
                "work/span/bytes=%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_frame,
                selected.output_work, selected.output_span, written);
        return 218;
    }
    status = select_relaxed(fs_base_jump, sizeof fs_base_jump, 0x1000u,
                            &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present || !selected.direct_frame
            || selected.output_work != 2u || selected.output_span != 2u
            || written != sizeof fs_base_jump) {
        fprintf(stderr,
                "native x86 selection: RED (segment-base near control "
                "status=%d source/normalized/direct=%u/%u/%u "
                "work/span/bytes=%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_frame,
                selected.output_work, selected.output_span, written);
        return 219;
    }
    static const pl_u8 gs_base_jump[] = {
        0xf3u, 0x49u, 0x0fu, 0xaeu, 0xd8u,
        0xe9u, 0xf6u, 0xffu, 0xffu, 0xffu,
    };
    static const pl_u8 gs_base_jump_result[] = {
        0xf3u, 0x49u, 0x0fu, 0xaeu, 0xd8u, 0xebu, 0x00u,
    };
    status = select(gs_base_jump, sizeof gs_base_jump, 0x1000u,
                    &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present || !selected.direct_frame
            || selected.output_work != 2u || selected.output_span != 2u
            || written != sizeof gs_base_jump_result
            || memcmp(output, gs_base_jump_result,
                      sizeof gs_base_jump_result)) {
        fprintf(stderr,
                "native x86 selection: RED (high-register GS base "
                "status=%d source/normalized/direct=%u/%u/%u "
                "work/span/bytes=%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_frame,
                selected.output_work, selected.output_span, written);
        return 220;
    }
    /* 2^32 is outside LEA's signed disp32. Keeping the constant as a live
     * RAX publication and using it as the LEA index is exactly two native
     * operations, despite the normalized addition having one SSA node. */
    static const pl_u8 wide_constant_add[] = {
        0x48u, 0xb8u, 0x00u, 0x00u, 0x00u, 0x00u,
        0x01u, 0x00u, 0x00u, 0x00u,
        0x4cu, 0x8du, 0x2cu, 0x06u,
    };
    status = select(wide_constant_add, sizeof wide_constant_add, 0x1000u,
                    &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !selected.direct_affine_frame
            || selected.output_work != 2u || selected.output_span != 2u
            || written != sizeof wide_constant_add
            || memcmp(output, wide_constant_add,
                      sizeof wide_constant_add)) {
        fprintf(stderr,
                "native x86 selection: RED (published wide constant add "
                "status=%d source/normalized/affine=%u/%u/%u "
                "work/span/bytes=%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_affine_frame,
                selected.output_work, selected.output_span, written);
        return 221;
    }
    pl_x86_native_candidates long_candidates;
    status = candidates(
        long_source_block, sizeof long_source_block, 0x1000u,
        &long_candidates);
    int long_source_present = 0;
    for (pl_u32 index = 0u; !status && index < long_candidates.count;
            ++index)
        long_source_present |= long_candidates.candidate[index].copied_source;
    if (status || !long_candidates.count || !long_source_present) {
        fprintf(stderr,
                "native x86 selection: RED (65+ instruction source "
                "closure status=%d candidates=%u source=%d)\n",
                status, long_candidates.count, long_source_present);
        return 24;
    }
    pl_x86_block shared_negated_block = { 0 };
    status = select_projected(
        shared_negated_mask, sizeof shared_negated_mask, 0x1ffffu,
        &selected, output, &written, &shared_negated_block);
    if (status || !selected.supported
            || selected.output_work != 4u || selected.output_span != 3u) {
        fprintf(stderr,
                "native x86 selection: RED (shared negated mask status=%d "
                "work/span/bytes=%u/%u/%u)\n",
                status, selected.output_work, selected.output_span,
                selected.output_bytes);
        print_block_shape(&shared_negated_block);
        return 25;
    }
    status = select_projected(
        aligned_negation, sizeof aligned_negation, 0x1ffffu,
        &selected, output, &written, 0);
    if (status || !selected.supported || selected.copied_source
            || selected.output_work != 1u || selected.output_span != 1u
            || selected.output_bytes != 2u || written != 2u
            || output[0] != 0xf7u || output[1] != 0xdeu) {
        fprintf(stderr,
                "native x86 selection: RED (aligned negation status=%d "
                "source/work/span/bytes=%u/%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 26;
    }
    status = select_projected(
        published_affine_branch, sizeof published_affine_branch,
        0x1ffffu, &selected, output, &written, 0);
    if (status || !selected.supported || selected.copied_source
            || selected.output_work != 6u || selected.output_span != 5u
            || written != 18u) {
        fprintf(stderr,
                "native x86 selection: RED (published affine branch "
                "status=%d source/work/span/bytes=%u/%u/%u/%u "
                "written=%u)\n",
                status, (unsigned)selected.copied_source,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        fputs("  code:", stderr);
        for (pl_u32 byte = 0u; byte < written; ++byte)
            fprintf(stderr, " %02x", output[byte]);
        fputc('\n', stderr);
        return 27;
    }
    pl_x86_block sign_extend_block = { 0 };
    status = select_projected(
        sign_extend_publication, sizeof sign_extend_publication,
        0x1ffffu, &selected, output, &written, &sign_extend_block);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_work != 5u || selected.output_span != 1u
            || written != sizeof sign_extend_publication) {
        fprintf(stderr,
                "native x86 selection: RED (sign-extend publication "
                "status=%d source/alu/work/span/bytes=%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        print_block_shape(&sign_extend_block);
        pl_x86_native_candidates diagnostic = { 0 };
        int candidate_status = candidates(
            sign_extend_publication, sizeof sign_extend_publication,
            0x1000u, &diagnostic);
        fprintf(stderr, "  candidates status/count=%d/%u\n",
                candidate_status, diagnostic.count);
        for (pl_u32 index = 0u; index < diagnostic.count; ++index)
            fprintf(stderr,
                    "  candidate[%u] source/alu/bytes/work/span=%u/%u/%u/%u/%u\n",
                    index,
                    (unsigned)diagnostic.candidate[index].copied_source,
                    (unsigned)diagnostic.candidate[index].direct_alu_frame,
                    diagnostic.candidate[index].output_bytes,
                    diagnostic.candidate[index].output_work,
                    diagnostic.candidate[index].output_span);
        return 28;
    }
    status = select_projected(
        arithmetic_width_source, sizeof arithmetic_width_source,
        0x1ffffu, &selected, output, &written, 0);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_work != 10u || selected.output_span != 4u
            || written != sizeof arithmetic_width_result
            || memcmp(output, arithmetic_width_result,
                      sizeof arithmetic_width_result)) {
        fprintf(stderr,
                "native x86 selection: RED (arithmetic-width quotient "
                "status=%d source/alu/work/span/bytes=%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        fprintf(stderr, "  output=");
        for (pl_u32 byte = 0u; byte < written; ++byte)
            fprintf(stderr, "%02x", output[byte]);
        fprintf(stderr, "\n");
        return 29;
    }
    status = select_projected(
        inplace_owner_source, sizeof inplace_owner_source,
        0x1ffffu, &selected, output, &written, 0);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_work != 5u || selected.output_span != 1u
            || written != sizeof inplace_owner_result
            || memcmp(output, inplace_owner_result,
                      sizeof inplace_owner_result)) {
        fprintf(stderr,
                "native x86 selection: RED (in-place owner "
                "status=%d source/alu/work/span/bytes=%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        return 30;
    }
    status = select_projected(
        published_subtree_source, sizeof published_subtree_source,
        0x1ffffu, &selected, output, &written, 0);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_work != 8u || selected.output_span != 4u
            || written != sizeof published_subtree_result
            || memcmp(output, published_subtree_result,
                      sizeof published_subtree_result)) {
        fprintf(stderr,
                "native x86 selection: RED (published subtree "
                "status=%d source/alu/work/span/bytes=%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        fputs("  code:", stderr);
        for (pl_u32 byte = 0u; byte < written; ++byte)
            fprintf(stderr, " %02x", output[byte]);
        fputc('\n', stderr);
        return 31;
    }
    status = select_projected(
        standalone_flags_source, sizeof standalone_flags_source,
        0x1ffffu, &selected, output, &written, 0);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_work != 6u || selected.output_span != 2u
            || written != sizeof standalone_flags_result
            || memcmp(output, standalone_flags_result,
                      sizeof standalone_flags_result)) {
        fprintf(stderr,
                "native x86 selection: RED (standalone flags lifetime "
                "status=%d source/alu/work/span/bytes=%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        return 32;
    }
    pl_x86_native_candidates published_add_candidates = { 0 };
    status = candidates(
        published_add_after_flags_source,
        sizeof published_add_after_flags_source,
        0x1000u, &published_add_candidates);
    int published_add_direct = 0;
    for (pl_u32 index = 0u;
            !status && index < published_add_candidates.count; ++index) {
        const pl_x86_native_selection *candidate =
            &published_add_candidates.candidate[index];
        if (!candidate->supported || candidate->copied_source
                || !candidate->direct_alu_frame
                || candidate->output_work != 5u
                || candidate->output_span != 4u
                || candidate->output_bytes
                   != sizeof published_add_after_flags_result)
            continue;
        pl_u32 candidate_written = 0u;
        int write_status = write_candidate(
            published_add_after_flags_source,
            sizeof published_add_after_flags_source, 0x1000u,
            candidate, output, sizeof output, &candidate_written);
        if (!write_status
                && candidate_written
                   == sizeof published_add_after_flags_result
                && !memcmp(output, published_add_after_flags_result,
                           sizeof published_add_after_flags_result))
            published_add_direct = 1;
    }
    if (status || !published_add_direct) {
        fprintf(stderr,
                "native x86 selection: RED (published add after flags "
                "status/count=%d/%u)\n",
                status, published_add_candidates.count);
        return 33;
    }
    pl_x86_native_candidates published_compare_candidates = { 0 };
    status = candidates(
        published_compare_source, sizeof published_compare_source,
        0x1000u, &published_compare_candidates);
    int published_compare_witness = 0;
    for (pl_u32 index = 0u;
            !status && index < published_compare_candidates.count; ++index) {
        const pl_x86_native_selection *candidate =
            &published_compare_candidates.candidate[index];
        if (!candidate->supported || candidate->copied_source
                || !candidate->direct_alu_frame
                || candidate->output_work != 5u
                || candidate->output_span != 4u
                || candidate->output_bytes
                   != sizeof published_compare_direct)
            continue;
        pl_u32 candidate_written = 0u;
        int write_status = write_candidate(
            published_compare_source, sizeof published_compare_source,
            0x1000u, candidate, output, sizeof output,
            &candidate_written);
        if (!write_status
                && candidate_written == sizeof published_compare_direct
                && !memcmp(output, published_compare_direct,
                           sizeof published_compare_direct))
            published_compare_witness = 1;
    }
    status = status ? status : select_projected(
        published_compare_source, sizeof published_compare_source,
        0x1ffffu, &selected, output, &written, 0);
    if (status || !published_compare_witness || !selected.supported
            || selected.copied_source || !selected.direct_alu_frame
            || selected.output_work != 5u
            || selected.output_span != 4u
            || written != sizeof published_compare_direct
            || memcmp(output, published_compare_direct,
                      sizeof published_compare_direct)) {
        fprintf(stderr,
                "native x86 selection: RED (published compare lifetime "
                "status/direct/source/work/span/bytes=%d/%d/%u/%u/%u/%u)\n",
                status, published_compare_witness,
                (unsigned)selected.copied_source,
                selected.output_work, selected.output_span, written);
        return 34;
    }
    status = select_projected(
        shared_inplace_owner_source, sizeof shared_inplace_owner_source,
        0x1ffffu, &selected, output, &written, 0);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_work != 7u || selected.output_span != 4u
            || written != sizeof shared_inplace_owner_result
            || memcmp(output, shared_inplace_owner_result,
                      sizeof shared_inplace_owner_result)) {
        fprintf(stderr,
                "native x86 selection: RED (shared in-place owner "
                "status=%d source/alu/work/span/bytes=%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        return 35;
    }
    status = select_projected(
        shared_diamond_source, sizeof shared_diamond_source,
        0x1ffffu, &selected, output, &written, 0);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame || !selected.direct_nested_frame
            || selected.output_work != 10u || selected.output_span != 3u
            || written != sizeof shared_diamond_result
            || memcmp(output, shared_diamond_result,
                      sizeof shared_diamond_result)) {
        fprintf(stderr,
                "native x86 selection: RED (shared internal diamond "
                "status=%d source/alu/nested/work/span/bytes="
                "%u/%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                selected.output_work, selected.output_span, written);
        return 36;
    }
    status = select_projected(
        affine_fanout_flags_source, sizeof affine_fanout_flags_source,
        0x1ffffu, &selected, output, &written, 0);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_work != 5u || selected.output_span != 1u
            || written != sizeof affine_fanout_flags_result
            || memcmp(output, affine_fanout_flags_result,
                      sizeof affine_fanout_flags_result)) {
        fprintf(stderr,
                "native x86 selection: RED (affine fanout and flag owner "
                "status=%d source/alu/work/span/bytes=%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        fputs("  code:", stderr);
        for (pl_u32 byte = 0u; byte < written; ++byte)
            fprintf(stderr, " %02x", output[byte]);
        fputc('\n', stderr);
        return 183;
    }
    status = select_projected(
        generation_join_source, sizeof generation_join_source,
        0x1ffffu, &selected, output, &written, 0);
    if (status || !selected.supported || !selected.copied_source
            || selected.output_work != 17u || selected.output_span != 7u
            || written != sizeof generation_join_source
            || memcmp(output, generation_join_source,
                      sizeof generation_join_source)) {
        fprintf(stderr,
                "native x86 selection: RED (entry/publication generation "
                "join status=%d source/alu/nested/work/span/bytes="
                "%u/%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                selected.output_work, selected.output_span, written);
        return 184;
    }
    status = select_projected(
        commutative_inplace_source, sizeof commutative_inplace_source,
        0x1ffffu, &selected, output, &written, 0);
    if (status || !selected.supported || !selected.copied_source
            || selected.output_work != 9u || selected.output_span != 4u
            || written != sizeof commutative_inplace_source
            || memcmp(output, commutative_inplace_source,
                      sizeof commutative_inplace_source)) {
        fprintf(stderr,
                "native x86 selection: RED (commutative in-place root "
                "status=%d source/alu/work/span/bytes=%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        pl_x86_native_candidates diagnostic = { 0 };
        int candidate_status = candidates_projected(
            commutative_inplace_source,
            sizeof commutative_inplace_source,
            0x1ffffu, &diagnostic);
        fprintf(stderr,
                "  candidates status/count/stage=%d/%u/0x%x "
                "reject=0x%x/0x%x alias=%u:%llx@%u\n",
                candidate_status, diagnostic.count,
                diagnostic.diagnostic_stage,
                diagnostic.diagnostic.blocking_work,
                diagnostic.diagnostic.blocking_opcode,
                (unsigned)diagnostic.diagnostic.frame_alias_kind,
                (unsigned long long)
                    diagnostic.diagnostic.frame_alias_value,
                (unsigned)diagnostic.diagnostic.frame_alias_local);
        for (pl_u32 index = 0u; index < diagnostic.count; ++index) {
            const pl_x86_native_selection *candidate =
                &diagnostic.candidate[index];
            fprintf(stderr,
                    "    %u: source/alu/nested/bytes/work/span="
                    "%u/%u/%u/%u/%u/%u alias=%u:%llx@%u\n",
                    index, (unsigned)candidate->copied_source,
                    (unsigned)candidate->direct_alu_frame,
                    (unsigned)candidate->direct_nested_frame,
                    candidate->output_bytes, candidate->output_work,
                    candidate->output_span,
                    (unsigned)candidate->frame_alias_kind,
                    (unsigned long long)candidate->frame_alias_value,
                    (unsigned)candidate->frame_alias_local);
        }
        pl_x86_block formed = { 0 };
        pl_x86_native_selection ignored_selection = { 0 };
        pl_u32 ignored_written = 0u;
        if (!select_projected(
                commutative_inplace_source,
                sizeof commutative_inplace_source,
                0x1ffffu, &ignored_selection, output,
                &ignored_written, &formed))
            print_block_shape(&formed);
        return 185;
    }
    status = select_projected(
        shared_rotate_join_source, sizeof shared_rotate_join_source,
        0x1ffffu, &selected, output, &written, 0);
    if (status || !selected.supported || !selected.copied_source
            || selected.output_work != 13u || selected.output_span != 6u
            || written != sizeof shared_rotate_join_source
            || memcmp(output, shared_rotate_join_source,
                      sizeof shared_rotate_join_source)) {
        fprintf(stderr,
                "native x86 selection: RED (shared rotate generation "
                "join status=%d source/alu/nested/alias/work/span/bytes="
                "%u/%u/%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                (unsigned)selected.frame_alias_present,
                selected.output_work, selected.output_span, written);
        return 186;
    }
    status = select_projected(
        quotient_boundary_source, sizeof quotient_boundary_source,
        0x1ffffu, &selected, output, &written, 0);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame || !selected.direct_nested_frame
            || selected.output_work != 6u || selected.output_span != 4u
            || written != sizeof quotient_boundary_result
            || memcmp(output, quotient_boundary_result,
                      sizeof quotient_boundary_result)) {
        fprintf(stderr,
                "native x86 selection: RED (quotient boundary projection "
                "status=%d source/alu/nested/work/span/bytes="
                "%u/%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                selected.output_work, selected.output_span, written);
        return 187;
    }
    status = select_projected(
        low32_scaled_index_source, sizeof low32_scaled_index_source,
        0x1ffffu, &selected, output, &written, 0);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_work != 5u || selected.output_span != 2u
            || written != sizeof low32_scaled_index_result
            || memcmp(output, low32_scaled_index_result,
                      sizeof low32_scaled_index_result)) {
        fprintf(stderr,
                "native x86 selection: RED (low32 scaled-index affine "
                "status=%d source/alu/work/span/bytes=%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        return 188;
    }
    status = select_projected(
        self_zero_copy_source, sizeof self_zero_copy_source,
        0x1ffffu, &selected, output, &written, 0);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_work != 4u || selected.output_span != 1u
            || written != sizeof self_zero_copy_result
            || memcmp(output, self_zero_copy_result,
                      sizeof self_zero_copy_result)) {
        fprintf(stderr,
                "native x86 selection: RED (self-zero publication "
                "status=%d source/alu/work/span/bytes=%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        return 189;
    }
    status = select_projected(
        root_accumulator_source, sizeof root_accumulator_source,
        0x1ffffu, &selected, output, &written, 0);
    if (status || !selected.supported || !selected.normalized_family_present
            || selected.output_work != 10u || selected.output_span != 5u
            || written != sizeof root_accumulator_result
            || memcmp(output, root_accumulator_result,
                      sizeof root_accumulator_result)) {
        fprintf(stderr,
                "native x86 selection: RED (root accumulator owner "
                "status=%d source/alu/work/span/bytes=%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        for (pl_u32 i = 0u; i < written; ++i) fprintf(stderr, "%02x ", output[i]);
        fputc('\n', stderr);
        return 190;
    }
    status = select_projected(
        shared_flag_select_source, sizeof shared_flag_select_source,
        0x1ffffu, &selected, output, &written, 0);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_work != 5u || selected.output_span != 3u
            || written != sizeof shared_flag_select_result
            || memcmp(output, shared_flag_select_result,
                      sizeof shared_flag_select_result)) {
        fprintf(stderr,
                "native x86 selection: RED (shared flag select handoff "
                "status=%d source/alu/work/span/bytes=%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        return 191;
    }
    pl_x86_native_candidates stack_candidates = { 0 };
    status = candidates(
        stack_frame_publication, sizeof stack_frame_publication,
        0x1000u, &stack_candidates);
    int joint_stack_witness = 0;
    for (pl_u32 index = 0u; !status && index < stack_candidates.count;
            ++index) {
        const pl_x86_native_selection *candidate =
            &stack_candidates.candidate[index];
        joint_stack_witness |= candidate->supported
            && candidate->output_work == 6u
            && candidate->output_span == 1u;
    }
    if (status || !joint_stack_witness) {
        fprintf(stderr,
                "native x86 selection: RED (stack-frame joint witness "
                "status/count=%d/%u)\n", status, stack_candidates.count);
        for (pl_u32 index = 0u; index < stack_candidates.count; ++index)
            fprintf(stderr,
                    "  candidate[%u] source/frame/alu/bytes/work/span="
                    "%u/%u/%u/%u/%u/%u\n", index,
                    (unsigned)stack_candidates.candidate[index].copied_source,
                    (unsigned)stack_candidates.candidate[index].direct_frame,
                    (unsigned)
                        stack_candidates.candidate[index].direct_alu_frame,
                    stack_candidates.candidate[index].output_bytes,
                    stack_candidates.candidate[index].output_work,
                    stack_candidates.candidate[index].output_span);
        pl_u8 diagnostic_bytes[64] = { 0u };
        pl_u32 diagnostic_written = 0u;
        int write_status = write_candidate(
            stack_frame_publication, sizeof stack_frame_publication,
            0x1000u, &stack_candidates.candidate[0],
            diagnostic_bytes, sizeof diagnostic_bytes,
            &diagnostic_written);
        fprintf(stderr, "  direct bytes status/count=%d/%u:",
                write_status, diagnostic_written);
        for (pl_u32 byte = 0u; byte < diagnostic_written; ++byte)
            fprintf(stderr, " %02x", diagnostic_bytes[byte]);
        fputc('\n', stderr);
        return 29;
    }
    pl_x86_block dynamic_shift_block = { 0 };
    status = select_projected(
        dynamic_shift_mask, sizeof dynamic_shift_mask, 0xffffu,
        &selected, output, &written, &dynamic_shift_block);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_work != 2u || selected.output_span != 2u
            || written != sizeof dynamic_shift_mask
            || memcmp(output, dynamic_shift_mask, sizeof dynamic_shift_mask)) {
        fprintf(stderr,
                "native x86 selection: RED (dynamic shift normalization "
                "status=%d source/alu/work/span/bytes=%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        print_block_shape(&dynamic_shift_block);
        return 30;
    }
    pl_x86_block tail_jump_block = { 0 };
    status = select_projected(
        tail_jump_frame, sizeof tail_jump_frame, 0xffffu,
        &selected, output, &written, &tail_jump_block);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_work != 3u || selected.output_span != 2u
            || written >= sizeof tail_jump_frame) {
        fprintf(stderr,
                "native x86 selection: RED (tail-jump frame status=%d "
                "source/alu/work/span/bytes=%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        print_block_shape(&tail_jump_block);
        return 31;
    }
    pl_x86_block alu_fanout_block = { 0 };
    status = select_projected(
        alu_projection_fanout, sizeof alu_projection_fanout, 0x1ffffu,
        &selected, output, &written, &alu_fanout_block);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_work != 6u || selected.output_span != 2u) {
        fprintf(stderr,
                "native x86 selection: RED (ALU projection fanout "
                "status=%d source/alu/work/span/bytes=%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        print_block_shape(&alu_fanout_block);
        return 32;
    }
    pl_x86_block entry_flags_block = { 0 };
    status = select_projected(
        entry_flags_select, sizeof entry_flags_select, 0x1ffffu,
        &selected, output, &written, &entry_flags_block);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_work != 4u || selected.output_span != 2u) {
        fprintf(stderr,
                "native x86 selection: RED (entry-flags select status=%d "
                "source/alu/work/span/bytes=%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        print_block_shape(&entry_flags_block);
        return 33;
    }
    pl_x86_block divide_sign_block = { 0 };
    status = select_projected(
        divide_sign_high, sizeof divide_sign_high, 0x1ffffu,
        &selected, output, &written, &divide_sign_block);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_work != 4u || selected.output_span != 2u
            || written != sizeof divide_sign_high
            || memcmp(output, divide_sign_high, sizeof divide_sign_high)) {
        fprintf(stderr,
                "native x86 selection: RED (divide sign-high status=%d "
                "source/alu/work/span/bytes=%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        print_block_shape(&divide_sign_block);
        return 34;
    }
    pl_x86_block word_split_block = { 0 };
    status = select_projected(
        word_split_publication, sizeof word_split_publication, 0x1ffffu,
        &selected, output, &written, &word_split_block);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_work != 6u || selected.output_span != 2u) {
        fprintf(stderr,
                "native x86 selection: RED (word split publication "
                "status=%d source/alu/work/span/bytes=%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        print_block_shape(&word_split_block);
        pl_x86_native_candidates split_candidates = { 0 };
        int split_status = candidates(
            word_split_publication, sizeof word_split_publication,
            0x1000u, &split_candidates);
        fprintf(stderr, "  candidates status/count=%d/%u\n",
                split_status, split_candidates.count);
        for (pl_u32 index = 0u; index < split_candidates.count; ++index)
            fprintf(stderr,
                    "  candidate[%u] source/alu/bytes/work/span="
                    "%u/%u/%u/%u/%u\n", index,
                    (unsigned)split_candidates.candidate[index].copied_source,
                    (unsigned)
                        split_candidates.candidate[index].direct_alu_frame,
                    split_candidates.candidate[index].output_bytes,
                    split_candidates.candidate[index].output_work,
                    split_candidates.candidate[index].output_span);
        return 35;
    }
    pl_x86_block preserved_flag_block = { 0 };
    status = select_projected(
        preserved_flag_prefix_branch,
        sizeof preserved_flag_prefix_branch, 0x1ffffu,
        &selected, output, &written, &preserved_flag_block);
    if (status || !selected.supported
            || selected.copied_source || !(selected.direct_branch_frame || selected.direct_alu_frame)
            || !selected.normalized_family_present
            || selected.output_work != 4u || selected.output_span != 2u
            || written != 9u) {
        fprintf(stderr,
                "native x86 selection: RED (preserved-flag prefix branch "
                "status=%d source/branch/work/span/bytes="
                "%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_branch_frame,
                selected.output_work, selected.output_span, written);
        print_block_shape(&preserved_flag_block);
        pl_x86_native_candidates flag_candidates = { 0 };
        int flag_status = candidates(
            preserved_flag_prefix_branch,
            sizeof preserved_flag_prefix_branch,
            0x1000u, &flag_candidates);
        fprintf(stderr, "  candidates status/count=%d/%u\n",
                flag_status, flag_candidates.count);
        for (pl_u32 index = 0u; index < flag_candidates.count; ++index)
            fprintf(stderr,
                    "  candidate[%u] source/branch/bytes/work/span="
                    "%u/%u/%u/%u/%u\n", index,
                    (unsigned)flag_candidates.candidate[index].copied_source,
                    (unsigned)
                        flag_candidates.candidate[index].direct_branch_frame,
                    flag_candidates.candidate[index].output_bytes,
                    flag_candidates.candidate[index].output_work,
                    flag_candidates.candidate[index].output_span);
        if (!flag_status && flag_candidates.count) {
            pl_u8 flag_bytes[64] = { 0u };
            pl_u32 flag_written = 0u;
            int write_status = write_candidate(
                preserved_flag_prefix_branch,
                sizeof preserved_flag_prefix_branch, 0x1000u,
                &flag_candidates.candidate[0], flag_bytes,
                sizeof flag_bytes, &flag_written);
            fprintf(stderr, "  direct bytes status/count=%d/%u:",
                    write_status, flag_written);
            for (pl_u32 byte = 0u; byte < flag_written; ++byte)
                fprintf(stderr, " %02x", flag_bytes[byte]);
            fputc('\n', stderr);
        }
        return 36;
    }
    pl_x86_block flag_producer_block = { 0 };
    status = select_projected(
        flag_producer_after_clobbering_add,
        sizeof flag_producer_after_clobbering_add, 0x1ffffu,
        &selected, output, &written, &flag_producer_block);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_work != 4u || selected.output_span != 3u
            || written != sizeof flag_producer_after_clobbering_add_result
            || memcmp(output, flag_producer_after_clobbering_add_result,
                      sizeof flag_producer_after_clobbering_add_result)) {
        fprintf(stderr,
                "native x86 selection: RED (flag producer after clobbering add "
                "status=%d source/alu/work/span/bytes=%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        print_block_shape(&flag_producer_block);
        fputs("  code:", stderr);
        for (pl_u32 byte = 0u; byte < written; ++byte)
            fprintf(stderr, " %02x", output[byte]);
        fputc('\n', stderr);
        return 90;
    }
    /* A three-input add whose inputs are all non-constant cannot be one LEA.
     * If the dense ALU frame is allowed to publish it after the compare, it
     * emits a flag-clobbering add/adc and the terminal branch reads the wrong
     * flags; that candidate then measures a phantom low span and the component
     * minima have no joint witness.  With the tree classified correctly the
     * candidate is a legal `span=5, work=9` spelling and the copied source's
     * `span=5, work=7` is the joint minimum. */
    static const pl_u8 add3_before_flag_producer[] = {
        0x89u, 0xd1u,                              /* mov ecx, edx   */
        0xb8u, 0x3fu, 0x00u, 0x00u, 0x00u,         /* mov eax, 0x3f  */
        0x4cu, 0x01u, 0xf9u,                       /* add rcx, r15   */
        0x48u, 0x29u, 0xc8u,                       /* sub rax, rcx   */
        0x4cu, 0x01u, 0xe9u,                       /* add rcx, r13   */
        0x48u, 0x83u, 0xf8u, 0x08u,                /* cmp rax, 8     */
        0x0fu, 0x82u, 0x00u, 0x00u, 0x00u, 0x00u,  /* jb .+0         */
    };
    pl_x86_native_candidates add3_candidates;
    status = candidates_projected(
        add3_before_flag_producer, sizeof add3_before_flag_producer,
        0x1ffffu, &add3_candidates);
    pl_x86_native_selection add3_selected = { 0 };
    pl_u32 add3_span = 0u, add3_work = 0u;
    int add3_status = status ? status
        : pl_x86_candidates_select_joint_minimum(
            &add3_candidates, 0u, 0u, &add3_selected,
            &add3_span, &add3_work);
    if (add3_status || !add3_selected.supported
            || add3_selected.output_span != 5u
            || add3_selected.output_work != 7u) {
        fprintf(stderr, "native x86 selection: RED (ADD3 before flag producer "
                "status=%d span/work=%u/%u)\n",
                add3_status, add3_span, add3_work);
        return 91;
    }
    /* An ADD3 whose shared pair is also a conditional arm another pending
     * publication needs.  Building the pair into the ordinary destination
     * makes the consumer rebuild it, so the dense ALU frame reaches span 7 at
     * work 15 while the copied source holds work 14 at span 8: no joint
     * witness.  With the pair built in the consumer's coordinate one
     * materialization serves both and the frame reaches span 7, work 14. */
    static const pl_u8 add3_shared_pair_consumer[] = {
        0x48u, 0xc1u, 0xe0u, 0x06u,               /* shl rax, 6        */
        0x48u, 0x89u, 0xc1u,                      /* mov rcx, rax      */
        0x48u, 0x29u, 0xd1u,                      /* sub rcx, rdx      */
        0x48u, 0x83u, 0xc2u, 0x01u,               /* add rdx, 1        */
        0x48u, 0x83u, 0xe9u, 0x01u,               /* sub rcx, 1        */
        0x48u, 0x89u, 0xf1u,                      /* mov rcx, rsi      */
        0x48u, 0x0fu, 0x48u, 0xc2u,               /* cmovs rax, rdx    */
        0x48u, 0xc1u, 0xe1u, 0x06u,               /* shl rcx, 6        */
        0x48u, 0x83u, 0xc1u, 0x3fu,               /* add rcx, 0x3f     */
        0x4au, 0x8du, 0x14u, 0x01u,               /* lea rdx, [rcx+r8] */
        0x49u, 0x39u, 0xd1u,                      /* cmp r9, rdx       */
        0x49u, 0x0fu, 0x48u, 0xcau,               /* cmovs rcx, r10    */
        0x48u, 0x39u, 0xc1u,                      /* cmp rcx, rax      */
        0x79u, 0x00u,                             /* jns .+0           */
    };
    pl_x86_native_candidates pair_candidates;
    status = candidates_projected(
        add3_shared_pair_consumer, sizeof add3_shared_pair_consumer,
        0x7ffffu, &pair_candidates);
    pl_x86_native_selection pair_selected = { 0 };
    pl_u32 pair_span = 0u, pair_work = 0u;
    int pair_status = status ? status
        : pl_x86_candidates_select_joint_minimum(
            &pair_candidates, 0u, 0u, &pair_selected,
            &pair_span, &pair_work);
    if (pair_status || !pair_selected.supported
            || pair_span != 7u || pair_work != 14u) {
        fprintf(stderr, "native x86 selection: RED (ADD3 shared pair consumer "
                "status=%d span/work=%u/%u)\n",
                pair_status, pair_span, pair_work);
        return 92;
    }
    /* A 32-bit sign extension of a node that another publication already
     * placed in a GPR.  Rebuilding the node inside the extension makes the
     * dense ALU frame materialize the negated entry word twice (span 2, work
     * 7) while the copied source holds work 6 at span 3: no joint witness.
     * Reading the node's published coordinate emits one `movslq` and the
     * frame reaches span 3, work 6. */
    static const pl_u8 extend_published_node[] = {
        0x48u, 0x89u, 0xf0u,                      /* mov rax, rsi      */
        0x48u, 0x29u, 0xf2u,                      /* sub rdx, rsi      */
        0xf7u, 0xd8u,                             /* neg eax           */
        0x48u, 0x89u, 0xd7u,                      /* mov rdi, rdx      */
        0x8du, 0x14u, 0x0eu,                      /* lea edx, [rsi+rcx]*/
        0x48u, 0x63u, 0xf0u,                      /* movslq rsi, eax   */
    };
    pl_x86_native_candidates extend_candidates;
    status = candidates_projected(
        extend_published_node, sizeof extend_published_node,
        0x7ffffu, &extend_candidates);
    pl_x86_native_selection extend_selected = { 0 };
    pl_u32 extend_span = 0u, extend_work = 0u;
    int extend_status = status ? status
        : pl_x86_candidates_select_joint_minimum(
            &extend_candidates, 0u, 0u, &extend_selected,
            &extend_span, &extend_work);
    if (extend_status || !extend_selected.supported
            || extend_span != 3u || extend_work != 6u) {
        fprintf(stderr, "native x86 selection: RED (extend published node "
                "status=%d span/work=%u/%u)\n",
                extend_status, extend_span, extend_work);
        return 93;
    }
    /* A conditional select whose tested flags are also the value of a separate
     * publication (the `and` here).  The select skips its own compare because
     * that publication emits the flags, so the frame's source law must order
     * the value publication first.  Without the dependency the select reads
     * the preceding `shl` flags (a miscompile the Pareto gate hides behind a
     * phantom `3/6` arm); with it both spellings are the source's `4/4`. */
    static const pl_u8 flag_select_value_publication[] = {
        0x89u, 0xd3u,                             /* mov ebx, edx      */
        0xd3u, 0xe3u,                             /* shl ebx, cl       */
        0x81u, 0xe3u, 0xbfu, 0xefu, 0xffu, 0xffu, /* and ebx, 0xffffefbf */
        0x48u, 0x0fu, 0x44u, 0xf8u,               /* cmove rdi, rax    */
    };
    pl_x86_native_candidates flag_value_candidates;
    status = candidates_projected(
        flag_select_value_publication,
        sizeof flag_select_value_publication, 0x7ffffu,
        &flag_value_candidates);
    pl_x86_native_selection flag_value_selected = { 0 };
    pl_u32 flag_value_span = 0u, flag_value_work = 0u;
    int flag_value_status = status ? status
        : pl_x86_candidates_select_joint_minimum(
            &flag_value_candidates, 0u, 0u, &flag_value_selected,
            &flag_value_span, &flag_value_work);
    if (flag_value_status || !flag_value_selected.supported
            || flag_value_span != 4u || flag_value_work != 4u) {
        fprintf(stderr, "native x86 selection: RED (flag select value "
                "publication status=%d span/work=%u/%u)\n",
                flag_value_status, flag_value_span, flag_value_work);
        return 94;
    }
    /* A generation-join seed materializes an entry-only subtree into the join
     * destination before a sibling publication overwrites the entry register.
     * That destination coordinate is live until the join, but the entry reads
     * it consumed are gone from the source law, so a later publication may
     * pick it as scratch.  Here the wide `and` mask would land in the join
     * destination and destroy the seed.  Naming the destination as its own
     * entry source keeps it out of every other scratch pool. */
    static const pl_u8 generation_join_seed_destination[] = {
        0x89u, 0xc8u,                             /* mov eax, ecx        */
        0x01u, 0xc9u,                             /* add ecx, ecx        */
        0xd0u, 0xe8u,                             /* shr al, 1           */
        0x81u, 0xe1u, 0x80u, 0x00u, 0x00u, 0x00u, /* and ecx, 0x80       */
        0x83u, 0xe0u, 0x40u,                      /* and eax, 0x40       */
        0x09u, 0xc8u,                             /* or eax, ecx         */
        0x89u, 0xd1u,                             /* mov ecx, edx        */
        0x80u, 0xe1u, 0x3fu,                      /* and cl, 0x3f        */
        0x09u, 0xc8u,                             /* or eax, ecx         */
        0x39u, 0xd0u,                             /* cmp eax, edx        */
    };
    pl_x86_native_candidates join_candidates;
    status = candidates_projected(
        generation_join_seed_destination,
        sizeof generation_join_seed_destination, 0x7ffffu,
        &join_candidates);
    pl_x86_native_selection join_selected = { 0 };
    pl_u32 join_span = 0u, join_work = 0u;
    int join_status = status ? status
        : pl_x86_candidates_select_joint_minimum(
            &join_candidates, 0u, 0u, &join_selected,
            &join_span, &join_work);
    if (join_status || !join_selected.supported
            || join_span != 6u || join_work != 10u) {
        fprintf(stderr, "native x86 selection: RED (generation join seed "
                "destination status=%d span/work=%u/%u)\n",
                join_status, join_span, join_work);
        return 95;
    }
    /* `insert(0, N2, 16)` is N2's 16-bit zero extension while the flags also
     * name N2.  Stripping the insert because of that flag relation publishes
     * N2's full 32-bit word; the same block then offers a phantom `3/6` arm
     * against the real `4/4` and no joint minimum.  The extension must be
     * emitted from N2's published coordinate. */
    static const pl_u8 zero_extend_flag_value[] = {
        0x48u, 0x89u, 0xcau,                      /* mov rdx, rcx      */
        0x48u, 0x29u, 0xf2u,                      /* sub rdx, rsi      */
        0x01u, 0xc2u,                             /* add edx, eax      */
        0x0fu, 0xb7u, 0xc2u,                      /* movzx eax, dx     */
    };
    pl_x86_native_candidates zero_extend_candidates;
    status = candidates_projected(
        zero_extend_flag_value, sizeof zero_extend_flag_value,
        0x7ffffu, &zero_extend_candidates);
    pl_x86_native_selection zero_extend_selected = { 0 };
    pl_u32 zero_extend_span = 0u, zero_extend_work = 0u;
    int zero_extend_status = status ? status
        : pl_x86_candidates_select_joint_minimum(
            &zero_extend_candidates, 0u, 0u, &zero_extend_selected,
            &zero_extend_span, &zero_extend_work);
    if (zero_extend_status || !zero_extend_selected.supported
            || zero_extend_span != 4u || zero_extend_work != 4u) {
        fprintf(stderr, "native x86 selection: RED (zero extend flag value "
                "status=%d span/work=%u/%u)\n",
                zero_extend_status, zero_extend_span, zero_extend_work);
        return 96;
    }
    /* `insert(0, inner, 32)` where `inner` is a 64-bit word sum with no
     * publication of its own.  The frame had no encoder for the extension
     * (blocking `0x500`), and once it materialises the inner it must accept a
     * 64-bit ADD3 as a 32-bit address coordinate.  The source spelling
     * `lea ecx,[rsi+rdx-1]` is the normalized candidate. */
    static const pl_u8 zero_extend_unpublished_inner[] = {
        0x8du, 0x4cu, 0x16u, 0xffu,               /* lea ecx, [rsi+rdx-1] */
        0x41u, 0xb9u, 0xffu, 0xffu, 0x0fu, 0x00u, /* mov r9d, 0xfffff    */
        0x89u, 0xf2u,                             /* mov edx, esi        */
        0x45u, 0x31u, 0xc0u,                      /* xor r8d, r8d        */
        0x4cu, 0x89u, 0xf6u,                      /* mov rsi, r14        */
        0x48u, 0xc7u, 0xc7u, 0x18u, 0xf4u, 0x8bu, 0x81u,
                                                  /* mov rdi, 0xffffffff818bf418 */
    };
    pl_x86_native_candidates inner_candidates;
    status = candidates_projected(
        zero_extend_unpublished_inner,
        sizeof zero_extend_unpublished_inner, 0x7ffffu, &inner_candidates);
    pl_x86_native_selection inner_selected = { 0 };
    pl_u32 inner_span = 0u, inner_work = 0u;
    int inner_status = status ? status
        : pl_x86_candidates_select_joint_minimum(
            &inner_candidates, 0u, 0u, &inner_selected,
            &inner_span, &inner_work);
    if (inner_status || !inner_selected.supported
            || inner_selected.copied_source
            || inner_span != 1u || inner_work != 6u) {
        fprintf(stderr, "native x86 selection: RED (zero extend unpublished "
                "inner status=%d copied=%u span/work=%u/%u)\n",
                inner_status, (unsigned)inner_selected.copied_source,
                inner_span, inner_work);
        return 97;
    }
    /* A flag-only X86_ALU whose value is dead (the coordinate is rewritten by a
     * constant copy) still feeds a conditional select.  The frame must accept
     * it and let the select's compare path emit the tested operation; requiring
     * a GPR value publication left the whole block copied-source. */
    static const pl_u8 flag_only_alu_select[] = {
        0x48u, 0x89u, 0xf1u,                      /* mov rcx, rsi        */
        0x49u, 0x89u, 0xf0u,                      /* mov r8, rsi         */
        0x48u, 0x83u, 0xe1u, 0xbfu,               /* and rcx, -0x41      */
        0x49u, 0x81u, 0xc8u, 0x00u, 0x01u, 0x00u, 0x00u,
                                                  /* or r8, 0x100        */
        0x48u, 0x81u, 0xc9u, 0x00u, 0x01u, 0x80u, 0x00u,
                                                  /* or rcx, 0x800100    */
        0x83u, 0xe6u, 0x40u,                      /* and esi, 0x40       */
        0xbeu, 0x83u, 0xffu, 0xffu, 0xffu,        /* mov esi, 0xffffff83 */
        0x49u, 0x0fu, 0x44u, 0xc8u,               /* cmove rcx, r8       */
    };
    pl_x86_native_candidates flag_only_candidates;
    status = candidates_projected(
        flag_only_alu_select, sizeof flag_only_alu_select,
        0x7ffffu, &flag_only_candidates);
    /* One normalized production must accept the block; before the relaxation
     * only the copied source was offered (count 1). */
    if (status || flag_only_candidates.count < 2u) {
        fprintf(stderr, "native x86 selection: RED (flag-only ALU select "
                "status=%d candidates=%u)\n",
                status, flag_only_candidates.count);
        return 98;
    }
    /* A self-XOR has no low-lane input, but the copied base still owns the
     * high bits. Neither its instruction nor its dependency may disappear. */
    static const pl_u8 copied_byte_clear[] = {
        0x48u, 0x89u, 0xd1u, 0x30u, 0xc9u, /* mov rcx,rdx; xor cl,cl */
    };
    static const pl_u8 copied_word_clear[] = {
        0x48u, 0x89u, 0xd1u, 0x66u, 0x31u, 0xc9u,
    };
    const pl_u8 *copied_clear[] = { copied_byte_clear, copied_word_clear };
    const pl_u32 copied_clear_bytes[] = {
        sizeof copied_byte_clear, sizeof copied_word_clear,
    };
    for (pl_u32 index = 0u; index < 2u; ++index) {
        status = select_projected(copied_clear[index], copied_clear_bytes[index],
            0x1ffffu, &selected, output, &written, 0);
        if (status || !selected.supported || selected.output_work != 2u
                || selected.output_span != 2u
                || written != copied_clear_bytes[index]
                || memcmp(output, copied_clear[index], written)) {
            fprintf(stderr, "native x86 selection: RED (copied lane clear "
                    "width=%u status=%d work/span/bytes=%u/%u/%u)\n",
                    index ? 16u : 8u, status, selected.output_work,
                    selected.output_span, written);
            return 242;
        }
    }
    /* `insert(local, constant, 8|16)` is an in-place lane constant write:
     * `mov r14b, 1` beside a register copy.  The frame had no production for a
     * constant inner (in_place_lane_insert only accepts a lane ALU inner), so
     * the block stayed copied-source. */
    static const pl_u8 lane_constant_write[] = {
        0x48u, 0x89u, 0xefu,                      /* mov rdi, rbp */
        0x41u, 0xb6u, 0x01u,                      /* mov r14b, 1  */
    };
    pl_x86_native_candidates lane_candidates;
    status = candidates_projected(
        lane_constant_write, sizeof lane_constant_write,
        0x7ffffu, &lane_candidates);
    pl_x86_native_selection lane_selected = { 0 };
    pl_u32 lane_span = 0u, lane_work = 0u;
    int lane_status = status ? status
        : pl_x86_candidates_select_joint_minimum(
            &lane_candidates, 0u, 0u, &lane_selected, &lane_span, &lane_work);
    if (lane_status || !lane_selected.supported
            || lane_selected.copied_source
            || lane_span != 1u || lane_work != 2u) {
        fprintf(stderr, "native x86 selection: RED (lane constant write "
                "status=%d copied=%u span/work=%u/%u)\n",
                lane_status, (unsigned)lane_selected.copied_source,
                lane_span, lane_work);
        return 99;
    }
    /* Two shifts of one unpublished root whose operands are exactly the two
     * destinations.  Each destination reads the coordinate the other
     * overwrites, so the compare-branch scheduler deadlocks; the handoff
     * evaluates the root once, copies it, and shifts each once. */
    static const pl_u8 shared_root_shift[] = {
        0x48u, 0x29u, 0xc3u,                      /* sub rbx, rax      */
        0x4cu, 0x89u, 0xe2u,                      /* mov rdx, r12      */
        0x48u, 0x89u, 0xd8u,                      /* mov rax, rbx      */
        0x48u, 0x29u, 0xcau,                      /* sub rdx, rcx      */
        0x48u, 0xc1u, 0xebu, 0x04u,               /* shr rbx, 4        */
        0x48u, 0xd1u, 0xe8u,                      /* shr rax, 1        */
        0x48u, 0xd1u, 0xeau,                      /* shr rdx, 1        */
        0x48u, 0x89u, 0xc1u,                      /* mov rcx, rax      */
        0x48u, 0x29u, 0xd1u,                      /* sub rcx, rdx      */
        0x48u, 0x39u, 0xd9u,                      /* cmp rcx, rbx      */
        0x0fu, 0x83u, 0x00u, 0x00u, 0x00u, 0x00u, /* jae .+0           */
    };
    pl_x86_native_candidates shared_root_candidates;
    status = candidates_projected(
        shared_root_shift, sizeof shared_root_shift,
        0x7ffffu, &shared_root_candidates);
    if (status || shared_root_candidates.count < 2u) {
        fprintf(stderr, "native x86 selection: RED (shared root shift "
                "status=%d candidates=%u)\n", status,
                shared_root_candidates.count);
        return 100;
    }
    /* A shared unpublished root consumed by a shift and by the final
     * flag-producing `and`, reaching both destinations transitively.  The
     * dense ALU frame deadlocked (0x200); the generalised handoff evaluates
     * the root once, copies it, applies the shift, then the and last. */
    static const pl_u8 shared_root_unary[] = {
        0x48u, 0xc1u, 0xe2u, 0x20u,               /* shl rdx, 0x20      */
        0x48u, 0x09u, 0xc2u,                      /* or rdx, rax        */
        0x48u, 0x89u, 0xd0u,                      /* mov rax, rdx       */
        0x48u, 0xc1u, 0xeau, 0x20u,               /* shr rdx, 0x20      */
        0x48u, 0x83u, 0xe0u, 0xbfu,               /* and rax, ~0x40     */
    };
    pl_x86_native_candidates root_unary_candidates;
    status = candidates_projected(
        shared_root_unary, sizeof shared_root_unary,
        0x7ffffu, &root_unary_candidates);
    if (status || root_unary_candidates.count < 2u) {
        fprintf(stderr, "native x86 selection: RED (shared root unary "
                "status=%d candidates=%u)\n", status,
                root_unary_candidates.count);
        return 101;
    }
    /* BIT_FLAGS keeps (prior, base, offset, width), including an immediate
     * offset.  Swapping the two register operands tests a different bit. */
    static const pl_u8 bit_test_constant_offset[] = {
        0x48u, 0xc7u, 0xc6u, 0xc8u, 0xd8u, 0x8cu, 0x81u,
                                                  /* movabs rsi, addr */
        0x48u, 0x0fu, 0xbau, 0xe0u, 0x23u,        /* bt rax, 0x23    */
        0x73u, 0x00u,                             /* jae .+0         */
    };
    pl_x86_native_candidates bit_test_candidates;
    status = candidates_projected(
        bit_test_constant_offset, sizeof bit_test_constant_offset,
        0x7ffffu, &bit_test_candidates);
    if (status || bit_test_candidates.count < 2u) {
        fprintf(stderr, "native x86 selection: RED (bit test constant offset "
                "status=%d candidates=%u)\n", status, bit_test_candidates.count);
        return 102;
    }
    /* GCC's musl allocator uses `bt %r8d,%ecx; jae`.  The equal-cost direct
     * candidate must test ECX at R8D, never R8D at ECX. */
    static const pl_u8 bit_test_register_offset[] = {
        0x44u, 0x0fu, 0xa3u, 0xc1u, 0x73u, 0x00u,
    };
    status = select(
        bit_test_register_offset, sizeof bit_test_register_offset,
        0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || written != sizeof bit_test_register_offset
            || memcmp(output, bit_test_register_offset,
                      sizeof bit_test_register_offset)) {
        fprintf(stderr, "native x86 selection: RED (bit test register order "
                "status=%d copied=%u written=%u)\n", status,
                (unsigned)selected.copied_source, written);
        return 213;
    }
    /* A consumed flag result must materialize each live dependent output.
     * The malloc path computes RCX = (RDX - R13) - 4 while retaining R15 and
     * the SUB flags.  Treating RCX's own future publication as an available
     * input used to erase the LEA and corrupted later address calculations. */
    static const pl_u8 consumed_flag_source[] = {
        0x48u, 0x89u, 0xd0u,                    /* mov rax, rdx */
        0x4cu, 0x0fu, 0xafu, 0xfau,             /* imul r15, rdx */
        0x4cu, 0x29u, 0xe8u,                    /* sub rax, r13 */
        0x48u, 0x8du, 0x48u, 0xfcu,             /* lea rcx, [rax-4] */
    };
    static const pl_u8 consumed_flag_result[] = {
        0x4cu, 0x0fu, 0xafu, 0xfau,             /* imul r15, rdx */
        0x4cu, 0x29u, 0xeau,                    /* sub rdx, r13 */
        0x48u, 0x8du, 0x4au, 0xfcu,             /* lea rcx, [rdx-4] */
    };
    status = select_projected(
        consumed_flag_source, sizeof consumed_flag_source,
        (1u << 1u) | (1u << 15u) | (1u << PL_X86_RFLAGS_LOCAL),
        &selected, output, &written, 0);
    if (status || !selected.supported || selected.copied_source
            || written != sizeof consumed_flag_result
            || memcmp(output, consumed_flag_result,
                      sizeof consumed_flag_result)) {
        fprintf(stderr, "native x86 selection: RED (consumed flag output "
                "status=%d copied=%u written=%u)\n", status,
                (unsigned)selected.copied_source, written);
        return 214;
    }
    status = select_projected(
        consumed_flag_source, sizeof consumed_flag_source,
        (1u << 1u) | (1u << 2u) | (1u << 15u)
            | (1u << PL_X86_RFLAGS_LOCAL),
        &selected, output, &written, 0);
    if (status || !selected.supported
            || written != sizeof consumed_flag_source
            || memcmp(output, consumed_flag_source,
                      sizeof consumed_flag_source)) {
        fprintf(stderr, "native x86 selection: RED (consumed flag keeps "
                "live source status=%d written=%u)\n", status, written);
        return 215;
    }
    /* The final flag producer combines an entry register with an immediate
     * while another publication overwrites that register.  The preload shape
     * only accepted a node value tree, so a bare entry local (`or rdx,0x1e`
     * with `rdx = rdx >> 32`) declined and the block stayed copied-source. */
    static const pl_u8 preload_entry_register[] = {
        0x48u, 0x89u, 0xd0u,                      /* mov rax, rdx       */
        0x48u, 0xc1u, 0xeau, 0x20u,               /* shr rdx, 0x20      */
        0x48u, 0x83u, 0xc8u, 0x1eu,               /* or rax, 0x1e       */
    };
    pl_x86_native_candidates preload_entry_candidates;
    status = candidates_projected(
        preload_entry_register, sizeof preload_entry_register,
        0x7ffffu, &preload_entry_candidates);
    if (status || preload_entry_candidates.count < 2u) {
        fprintf(stderr, "native x86 selection: RED (preload entry register "
                "status=%d candidates=%u)\n", status,
                preload_entry_candidates.count);
        return 103;
    }
    /* A conditional select whose constant candidate is published to the same
     * register its current arm reads as an entry.  Binding the constant to its
     * publication makes the select depend on that publication while the
     * publication overwrites the entry the current needs -- a cycle.  The
     * source preloads the current, then materialises the constant, then cmovs. */
    static const pl_u8 select_over_published_constant[] = {
        0x48u, 0x89u, 0xc6u,                      /* mov rsi, rax       */
        0xb8u, 0x00u, 0x00u, 0x00u, 0x00u,        /* mov eax, 0         */
        0x48u, 0x0fu, 0x48u, 0xf0u,               /* cmovs rsi, rax     */
    };
    pl_x86_native_candidates constant_candidates;
    status = candidates_projected(
        select_over_published_constant,
        sizeof select_over_published_constant, 0x7ffffu,
        &constant_candidates);
    pl_x86_native_selection constant_selected = { 0 };
    pl_u32 constant_span = 0u, constant_work = 0u;
    int constant_status = status ? status
        : pl_x86_candidates_select_joint_minimum(
            &constant_candidates, 0u, 0u, &constant_selected,
            &constant_span, &constant_work);
    if (constant_status || constant_candidates.count < 2u
            || !constant_selected.supported
            || constant_span != 2u || constant_work != 3u) {
        fprintf(stderr, "native x86 selection: RED (select over published "
                "constant status=%d candidates=%u span/work=%u/%u "
                "diagnostic=0x%x)\n", status,
                constant_candidates.count, constant_span, constant_work,
                constant_candidates.diagnostic.blocking_work);
        return 104;
    }
    /* CMP consumes entry EAX through an AND tree, while the CMOV candidate
     * publishes a new EAX. The only valid schedule is to evaluate and test
     * the old EAX before publishing the candidate; MOV and CMOV preserve the
     * comparison flags. This must not use the immediate-select shortcut. */
    static const pl_u8 compare_before_candidate[] = {
        0x83u, 0xe0u, 0x07u,             /* and eax, 7         */
        0xbbu, 0x57u, 0x13u, 0u, 0u,   /* mov ebx, 0x1357   */
        0x83u, 0xf8u, 0x03u,             /* cmp eax, 3         */
        0xb8u, 0x68u, 0x24u, 0u, 0u,   /* mov eax, 0x2468   */
        0x0fu, 0x44u, 0xd8u,             /* cmove ebx, eax    */
        0xebu, 0x00u,                    /* jmp next          */
    };
    pl_x86_native_candidates compare_handoff_candidates;
    status = candidates_projected(
        compare_before_candidate, sizeof compare_before_candidate,
        0x7ffffu, &compare_handoff_candidates);
    if (status || compare_handoff_candidates.count < 2u) {
        fprintf(stderr, "native x86 selection: RED (compare before candidate "
                "status=%d candidates=%u diagnostic=0x%x)\n", status,
                compare_handoff_candidates.count,
                compare_handoff_candidates.diagnostic.blocking_work);
        return 222;
    }
    const pl_x86_native_selection *compare_handoff_frame = 0;
    for (pl_u32 index = 0u;
            index < compare_handoff_candidates.count; ++index)
        if (compare_handoff_candidates.candidate[index]
                .direct_compare_tree_select_frame)
            compare_handoff_frame =
                &compare_handoff_candidates.candidate[index];
    static const pl_u8 compare_handoff_result[] = {
        0x83u, 0xe0u, 0x07u,             /* and eax, 7         */
        0x83u, 0xf8u, 0x03u,             /* cmp eax, 3         */
        0xbbu, 0x57u, 0x13u, 0u, 0u,   /* mov ebx, 0x1357   */
        0xb8u, 0x68u, 0x24u, 0u, 0u,   /* mov eax, 0x2468   */
        0x0fu, 0x44u, 0xd8u,             /* cmove ebx, eax    */
        0xebu, 0x00u,                    /* jmp next          */
    };
    status = compare_handoff_frame ? write_projected_candidate(
        compare_before_candidate, sizeof compare_before_candidate,
        0x7ffffu, compare_handoff_frame, output, &written) : -1;
    if (status || written != sizeof compare_handoff_result
            || memcmp(output, compare_handoff_result,
                sizeof compare_handoff_result)) {
        fprintf(stderr, "native x86 selection: RED (compare before "
                "candidate emission status=%d bytes=%u)\n",
                status, written);
        return 224;
    }
    static const pl_u8 compare_before_current[] = {
        0x83u, 0xe0u, 0x07u,             /* and eax, 7         */
        0xbbu, 0x68u, 0x24u, 0u, 0u,   /* mov ebx, 0x2468   */
        0x83u, 0xf8u, 0x03u,             /* cmp eax, 3         */
        0xb8u, 0x57u, 0x13u, 0u, 0u,   /* mov eax, 0x1357   */
        0x0fu, 0x44u, 0xc3u,             /* cmove eax, ebx    */
        0xebu, 0x00u,                    /* jmp next          */
    };
    pl_x86_native_candidates compare_current_candidates;
    status = candidates_projected(
        compare_before_current, sizeof compare_before_current,
        0x7ffffu, &compare_current_candidates);
    const pl_x86_native_selection *compare_current_frame = 0;
    for (pl_u32 index = 0u;
            !status && index < compare_current_candidates.count; ++index)
        if (compare_current_candidates.candidate[index]
                .direct_compare_tree_select_frame)
            compare_current_frame =
                &compare_current_candidates.candidate[index];
    if (status || !compare_current_frame) {
        fprintf(stderr, "native x86 selection: RED (compare before current "
                "status=%d candidates=%u diagnostic=0x%x)\n", status,
                compare_current_candidates.count,
                compare_current_candidates.diagnostic.blocking_work);
        return 223;
    }
    static const pl_u8 compare_current_result[] = {
        0x83u, 0xe0u, 0x07u,             /* and eax, 7         */
        0x83u, 0xf8u, 0x03u,             /* cmp eax, 3         */
        0xb8u, 0x57u, 0x13u, 0u, 0u,   /* mov eax, 0x1357   */
        0xbbu, 0x68u, 0x24u, 0u, 0u,   /* mov ebx, 0x2468   */
        0x0fu, 0x44u, 0xc3u,             /* cmove eax, ebx    */
        0xebu, 0x00u,                    /* jmp next          */
    };
    status = write_projected_candidate(
        compare_before_current, sizeof compare_before_current,
        0x7ffffu, compare_current_frame, output, &written);
    if (status || written != sizeof compare_current_result
            || memcmp(output, compare_current_result,
                sizeof compare_current_result)) {
        fprintf(stderr, "native x86 selection: RED (compare before "
                "current emission status=%d bytes=%u)\n",
                status, written);
        return 225;
    }
    /* The linked .rodata immediate retains its owning MOV byte-for-byte.
     * BSR's zero-input seed is also live: input AL < 16 reaches zero after
     * SHR, and the following ADD must then produce zero, not old ECX + 1. */
    static const pl_u8 live_construction_source[] = {
        0x48u, 0x89u, 0xd7u,
        0xbeu, 0x00u, 0x10u, 0x00u, 0x00u,
        0x48u, 0xc7u, 0xc2u, 0x4cu, 0x02u, 0x8eu, 0x81u,
        0xb9u, 0xffu, 0xffu, 0xffu, 0xffu,
        0xc0u, 0xe8u, 0x04u,
        0x0fu, 0xb6u, 0xc0u,
        0x0fu, 0xbdu, 0xc8u,
        0x83u, 0xc1u, 0x01u,
    };
    static const pl_u8 live_construction_result[] = {
        0x48u, 0x89u, 0xd7u,
        0xbeu, 0x00u, 0x10u, 0x00u, 0x00u,
        0x48u, 0xc7u, 0xc2u, 0x4cu, 0x02u, 0x8eu, 0x81u,
        0xb9u, 0xffu, 0xffu, 0xffu, 0xffu,
        0xc0u, 0xe8u, 0x04u,
        0x0fu, 0xb6u, 0xc0u,
        0x0fu, 0xbdu, 0xc8u,
        0x83u, 0xc1u, 0x01u,
    };
    status = select_with_fields(
        live_construction_source, sizeof live_construction_source,
        0x1000u, 1, 0, &selected, output, &written);
    if (status
            || written != sizeof live_construction_result
            || memcmp(output, live_construction_result,
                sizeof live_construction_result)) {
        fprintf(stderr, "native x86 selection: RED (live construction "
                "status=%d frame=%u bytes=%u)\n", status,
                (unsigned)selected.direct_live_frame, written);
        return 226;
    }
    /* Three acyclic entry-register publications precede a condition on
     * entry RFLAGS. The 32-bit MOV is a zero extension, not a second value
     * computation; a linked near Jcc field remains a control fixup. */
    static const pl_u8 entry_flag_extension_branch[] = {
        0x48u, 0x89u, 0xf5u,             /* mov rbp, rsi       */
        0x48u, 0x89u, 0xd3u,             /* mov rbx, rdx       */
        0x89u, 0xfeu,                    /* mov esi, edi       */
        0x0fu, 0x8eu, 0u, 0u, 0u, 0u,  /* jle next           */
    };
    static const pl_u8 entry_flag_extension_result[] = {
        0x48u, 0x89u, 0xd3u,             /* mov rbx, rdx       */
        0x48u, 0x89u, 0xf5u,             /* mov rbp, rsi       */
        0x89u, 0xfeu,                    /* mov esi, edi       */
        0x0fu, 0x8eu, 0u, 0u, 0u, 0u,  /* jle next           */
    };
    status = select_with_fields(
        entry_flag_extension_branch,
        sizeof entry_flag_extension_branch,
        0x1000u, 1, 1, &selected, output, &written);
    if (status || !selected.direct_entry_branch_frame
            || written != sizeof entry_flag_extension_result
            || memcmp(output, entry_flag_extension_result,
                sizeof entry_flag_extension_result)) {
        fprintf(stderr, "native x86 selection: RED (entry flag extension "
                "status=%d frame=%u bytes=%u)\n", status,
                (unsigned)selected.direct_entry_branch_frame, written);
        return 227;
    }
    /* The AND result is killed by the following full-width MOV, but its
     * complete defined flags survive to the branch. A 16-bit TEST of 0x80
     * retains ZF/PF and has SF=CF=OF=0 just like the 32-bit AND. The 8-bit
     * spelling is invalid here because it would set SF for bit 7. */
    static const pl_u8 masked_flag_branch[] = {
        0x81u, 0xe6u, 0x80u, 0u, 0u, 0u, /* and esi, 0x80   */
        0x48u, 0x89u, 0xe6u,             /* mov rsi, rsp    */
        0x75u, 0u,                      /* jne next        */
    };
    static const pl_u8 masked_flag_branch_result[] = {
        0x66u, 0xf7u, 0xc6u, 0x80u, 0u, /* test si, 0x80  */
        0x48u, 0x89u, 0xe6u,             /* mov rsi, rsp    */
        0x75u, 0u,                      /* jne next        */
    };
    status = select(masked_flag_branch, sizeof masked_flag_branch,
                    0x1000u, &selected, output, &written);
    if (status || !selected.direct_mask_flag_branch_frame
            || written != sizeof masked_flag_branch_result
            || memcmp(output, masked_flag_branch_result,
                sizeof masked_flag_branch_result)) {
        fprintf(stderr, "native x86 selection: RED (masked flag branch "
                "status=%d frame=%u bytes=%u)\n", status,
                (unsigned)selected.direct_mask_flag_branch_frame, written);
        return 228;
    }
#if defined(__x86_64__) && defined(__GNUC__)
    /* AF is architecturally undefined for both logical instructions.
     * Compare every defined arithmetic flag after the flag-preserving MOV. */
    static const pl_u32 masks[] = {
        0u, 1u, 0x7fu, 0x80u, 0xffu, 0x100u, 0x7fffu,
    };
    for (pl_u32 mask_at = 0u;
            mask_at < sizeof masks / sizeof masks[0]; ++mask_at) {
        pl_u32 mask = masks[mask_at];
        for (pl_u32 value = 0u; value < 65536u; ++value) {
            pl_u32 input = value
                | ((value * 0x9e3779b9u) & 0xffff0000u);
            pl_u64 narrowed = mask <= 0x7fu
                ? test8_mask_flags(input, mask)
                : test16_mask_flags(input, mask);
            if (((and32_mask_flags(input, mask) ^ narrowed)
                    & 0x8c5u) != 0u) {
                fprintf(stderr, "native x86 selection: RED (masked flags "
                        "input=0x%x mask=0x%x)\n", input, mask);
                return 229;
            }
        }
    }
#endif
    static const pl_u8 sign_bit_mask_branch[] = {
        0x81u, 0xe6u, 0u, 0x80u, 0u, 0u, /* and esi, 0x8000 */
        0x48u, 0x89u, 0xe6u,
        0x75u, 0u,
    };
    status = select(sign_bit_mask_branch, sizeof sign_bit_mask_branch,
                    0x1000u, &selected, output, &written);
    if (status || selected.direct_mask_flag_branch_frame) {
        fprintf(stderr, "native x86 selection: RED (narrow TEST would "
                "change SF, status=%d frame=%u)\n", status,
                (unsigned)selected.direct_mask_flag_branch_frame);
        return 230;
    }
    /* A CMP/TEST publishes no GPR value, but its condition projection is a
     * Boolean observation (`sete al`).  The frame only accepted ALU value
     * publications, so the compare's Boolean publication declined and the
     * block stayed copied-source.  The frame now emits the comparison and its
     * SETcc observations as one group. */
    static const pl_u8 compare_boolean_observation[] = {
        0x83u, 0xe2u, 0x07u,                      /* and edx, 7         */
        0x31u, 0xc0u,                            /* xor eax, eax       */
        0x80u, 0xfau, 0x06u,                     /* cmp dl, 6          */
        0x0fu, 0x94u, 0xc0u,                     /* sete al            */
    };
    pl_x86_native_candidates boolean_candidates;
    status = candidates_projected(
        compare_boolean_observation,
        sizeof compare_boolean_observation, 0x7ffffu,
        &boolean_candidates);
    if (status || boolean_candidates.count < 2u) {
        fprintf(stderr, "native x86 selection: RED (compare boolean "
                "observation status=%d candidates=%u diagnostic=0x%x)\n",
                status, boolean_candidates.count,
                boolean_candidates.diagnostic.blocking_work);
        return 105;
    }
    /* A CMP whose operand is an expression no register publishes (`and
     * eax,mask; cmp eax,imm; mov eax,0`) has no GPR result to own the AND, so
     * standalone_flag_publication_details declined (0xf003).  The frame now
     * materializes the operand tree into a scratch before the comparison. */
    static const pl_u8 compare_over_unpublished_tree[] = {
        0x25u, 0xc0u, 0xffu, 0xffu, 0x00u,        /* and eax, 0xffffc0  */
        0x3du, 0x00u, 0x0fu, 0x02u, 0x00u,        /* cmp eax, 0x20f00   */
        0xb8u, 0x00u, 0x00u, 0x00u, 0x00u,        /* mov eax, 0         */
        0x74u, 0x00u,                             /* je .               */
    };
    pl_x86_native_candidates tree_candidates;
    status = candidates_projected(
        compare_over_unpublished_tree,
        sizeof compare_over_unpublished_tree, 0x7ffffu, &tree_candidates);
    if (status || tree_candidates.count < 2u) {
        fprintf(stderr, "native x86 selection: RED (compare over "
                "unpublished tree status=%d candidates=%u diagnostic=0x%x)\n",
                status, tree_candidates.count,
                tree_candidates.diagnostic.blocking_work);
        return 106;
    }
    /* Tail dispatch: constant/copy publications followed by an indirect jump.
     * The ALU frame rejected every dynamic target, so the block stayed
     * copied-source; it now emits the publications and `jmp *target`. */
    static const pl_u8 indirect_dispatch[] = {
        0xbau, 0x01u, 0x00u, 0x00u, 0x00u,        /* mov edx, 1         */
        0xbeu, 0xecu, 0x00u, 0x00u, 0x00u,        /* mov esi, 0xec      */
        0x31u, 0xffu,                             /* xor edi, edi       */
        0xffu, 0xe0u,                             /* jmp *rax           */
    };
    pl_x86_native_candidates dispatch_candidates;
    status = candidates_projected(
        indirect_dispatch, sizeof indirect_dispatch, 0x7ffffu,
        &dispatch_candidates);
    if (status || dispatch_candidates.count < 2u) {
        fprintf(stderr, "native x86 selection: RED (indirect dispatch "
                "status=%d candidates=%u diagnostic=0x%x)\n",
                status, dispatch_candidates.count,
                dispatch_candidates.diagnostic.blocking_work);
        return 107;
    }
    /* A comparison whose carry feeds an `adc`/`sbb` stays in the ALU's
     * prior-flags operand instead of the entry RFLAGS local, which
     * alu_frame_shape rejected.  The frame now emits the comparison and then
     * the carry-consuming ALU. */
    static const pl_u8 carry_alu_from_compare[] = {
        0x48u, 0x83u, 0xfdu, 0x01u,               /* cmp rbp, 1         */
        0x48u, 0x89u, 0xeau,                      /* mov rdx, rbp       */
        0x4cu, 0x89u, 0xe7u,                      /* mov rdi, r12       */
        0xbeu, 0x02u, 0x00u, 0x00u, 0x00u,        /* mov esi, 2         */
        0x83u, 0xd6u, 0x00u,                      /* adc esi, 0         */
    };
    pl_x86_native_candidates carry_candidates;
    status = candidates_projected(
        carry_alu_from_compare,
        sizeof carry_alu_from_compare, 0x7ffffu, &carry_candidates);
    if (status || carry_candidates.count < 2u) {
        fprintf(stderr, "native x86 selection: RED (carry ALU from compare "
                "status=%d candidates=%u diagnostic=0x%x)\n",
                status, carry_candidates.count,
                carry_candidates.diagnostic.blocking_work);
        return 108;
    }
    /* The carry consumed by ADC is produced by CMP, not by the preceding
     * SHL.  The final ADC flags and both copies of its result are observed. */
    static const pl_u8 shift_compare_carry[] = {
        0xc1u, 0xe0u, 0x07u,                     /* shl eax, 7         */
        0x48u, 0x83u, 0xfdu, 0x01u,              /* cmp rbp, 1         */
        0x83u, 0xd0u, 0x00u,                     /* adc eax, 0         */
        0x41u, 0x89u, 0xc4u,                     /* mov r12d, eax      */
        0x66u, 0x66u, 0x2eu, 0x0fu, 0x1fu, 0x84u, 0x00u,
        0x00u, 0x00u, 0x00u, 0x00u,              /* alignment NOP      */
    };
    pl_x86_native_candidates shift_carry_candidates;
    status = candidates_projected(
        shift_compare_carry, sizeof shift_compare_carry,
        0x11001u, &shift_carry_candidates);
    static const pl_u8 shift_compare_carry_result[] = {
        0xc1u, 0xe0u, 0x07u,
        0x48u, 0x83u, 0xfdu, 0x01u,
        0x83u, 0xd0u, 0x00u,
        0x41u, 0x89u, 0xc4u,
    };
    pl_u8 shift_carry_output[SELECT_OUTPUT_CAPACITY];
    pl_u32 shift_carry_written = 0u;
    if (!status && shift_carry_candidates.count)
        status = write_projected_candidate(
            shift_compare_carry, sizeof shift_compare_carry,
            0x11001u, &shift_carry_candidates.candidate[0],
            shift_carry_output, &shift_carry_written);
    if (status || !shift_carry_candidates.count
            || shift_carry_written != sizeof shift_compare_carry_result
            || memcmp(shift_carry_output, shift_compare_carry_result,
                      sizeof shift_compare_carry_result)) {
        fprintf(stderr, "native x86 selection: RED (shift/compare/ADC "
                "carry provenance status=%d candidates=%u first_bytes=%u)\n",
                status, shift_carry_candidates.count,
                shift_carry_candidates.count
                    ? shift_carry_candidates.candidate[0].output_bytes : 0u);
        return 210;
    }
    /* The result is copied to RAX and RDX, but the OR still consumes the
     * entry RDX. Publishing the masked left operand into RDX first turns
     * the OR into "or rdx, rdx" and passes a zero-length slice to the call. */
    static const pl_u8 shared_alu_entry_operand[] = {
        0x4cu, 0x89u, 0xd8u,                     /* mov rax, r11       */
        0x48u, 0x89u, 0xcfu,                     /* mov rdi, rcx       */
        0x4cu, 0x89u, 0xd6u,                     /* mov rsi, r10       */
        0x49u, 0xb8u, 0x00u, 0x00u, 0x00u, 0x00u,
        0xffu, 0xffu, 0xffu, 0xffu,             /* movabs r8, mask   */
        0x4cu, 0x21u, 0xc0u,                     /* and rax, r8       */
        0x48u, 0x09u, 0xd0u,                     /* or rax, rdx       */
        0x48u, 0x89u, 0xc2u,                     /* mov rdx, rax      */
    };
    pl_x86_native_candidates shared_alu_candidates;
    status = candidates_projected(
        shared_alu_entry_operand, sizeof shared_alu_entry_operand,
        0x101c5u, &shared_alu_candidates);
    pl_u8 shared_alu_output[SELECT_OUTPUT_CAPACITY];
    pl_u32 shared_alu_written = 0u;
    if (!status && shared_alu_candidates.count)
        status = write_projected_candidate(
            shared_alu_entry_operand, sizeof shared_alu_entry_operand,
            0x101c5u, &shared_alu_candidates.candidate[0],
            shared_alu_output, &shared_alu_written);
    if (status || !shared_alu_candidates.count
            || shared_alu_written != sizeof shared_alu_entry_operand
            || memcmp(shared_alu_output, shared_alu_entry_operand,
                      sizeof shared_alu_entry_operand)) {
        fprintf(stderr, "native x86 selection: RED (shared ALU result "
                "overwrites entry operand status=%d candidates=%u)\n",
                status, shared_alu_candidates.count);
        return 211;
    }
    /* A flag-producing ALU whose value AND carry Boolean are both published
     * (`sub rax,rdx; setb dil; neg rdx`): the ALU frame now runs
     * flag_result_group_shape so the instruction and its SETcc leave together. */
    static const pl_u8 alu_with_boolean_group[] = {
        0x31u, 0xffu,                             /* xor edi, edi       */
        0x48u, 0x29u, 0xd0u,                      /* sub rax, rdx       */
        0x40u, 0x0fu, 0x92u, 0xc7u,               /* setb dil           */
        0x48u, 0xf7u, 0xdau,                      /* neg rdx            */
        0x79u, 0x00u,                             /* jns .              */
    };
    pl_x86_native_candidates bool_group_candidates;
    status = candidates_projected(
        alu_with_boolean_group, sizeof alu_with_boolean_group, 0x7ffffu,
        &bool_group_candidates);
    if (status || bool_group_candidates.count < 2u) {
        fprintf(stderr, "native x86 selection: RED (ALU with Boolean group "
                "status=%d candidates=%u diagnostic=0x%x)\n",
                status, bool_group_candidates.count,
                bool_group_candidates.diagnostic.blocking_work);
        return 109;
    }
    /* `insert(0, inner, 16)` over an inner node with no publication: the frame
     * materializes the inner at its own width and then MOVZXes the lane.  The
     * 32-bit form already existed; the narrow lanes fell through to
     * operand_expression_bits and blocked at 0x500. */
    static const pl_u8 narrow_zero_extend[] = {
        0x48u, 0x89u, 0xd1u,                      /* mov rcx, rdx       */
        0x48u, 0xc1u, 0xe9u, 0x20u,               /* shr rcx, 0x20      */
        0x0fu, 0xb7u, 0xc9u,                      /* movzx ecx, cx      */
    };
    pl_x86_native_candidates narrow_candidates;
    status = candidates_projected(
        narrow_zero_extend, sizeof narrow_zero_extend, 0x7ffffu,
        &narrow_candidates);
    if (status || narrow_candidates.count < 2u) {
        fprintf(stderr, "native x86 selection: RED (narrow zero extend "
                "status=%d candidates=%u diagnostic=0x%x)\n",
                status, narrow_candidates.count,
                narrow_candidates.diagnostic.blocking_work);
        return 110;
    }
    /* `setne dl` is a lane insert of an entry-flags condition into a live RDX.
     * The frame emits SETcc and must order it before the block's later flag
     * producer (`xor ecx,ecx`), which publication_reads_entry_flags now
     * enforces. */
    static const pl_u8 setcc_lane_insert[] = {
        0x4cu, 0x89u, 0xe6u,                      /* mov rsi, r12       */
        0x48u, 0x89u, 0xdfu,                      /* mov rdi, rbx       */
        0x0fu, 0x95u, 0xc2u,                      /* setne dl           */
        0x31u, 0xc9u,                             /* xor ecx, ecx       */
    };
    pl_x86_native_candidates setcc_candidates;
    status = candidates_projected(
        setcc_lane_insert, sizeof setcc_lane_insert, 0x7ffffu,
        &setcc_candidates);
    if (status || setcc_candidates.count < 2u) {
        fprintf(stderr, "native x86 selection: RED (setcc lane insert "
                "status=%d candidates=%u diagnostic=0x%x)\n",
                status, setcc_candidates.count,
                setcc_candidates.diagnostic.blocking_work);
        return 111;
    }
    /* An X86_FLAGS wrapper whose published value is the sign-extension of the
     * flag result (`neg rax; cltq`): MOVSX/Q preserves flags, so the extension
     * still carries the flag provenance and the frame can emit the value. */
    static const pl_u8 flags_with_sign_extend[] = {
        0x48u, 0x89u, 0xd8u,                      /* mov rax, rbx       */
        0x48u, 0xf7u, 0xd8u,                      /* neg rax            */
        0x48u, 0x98u,                             /* cltq               */
    };
    pl_x86_native_candidates sign_extend_candidates;
    status = candidates_projected(
        flags_with_sign_extend, sizeof flags_with_sign_extend, 0x7ffffu,
        &sign_extend_candidates);
    if (status || sign_extend_candidates.count < 2u) {
        fprintf(stderr, "native x86 selection: RED (flags with sign extend "
                "status=%d candidates=%u diagnostic=0x%x)\n",
                status, sign_extend_candidates.count,
                sign_extend_candidates.diagnostic.blocking_work);
        return 112;
    }
    /* `insert(base, 0, 8)` with base != destination (`mov rax,rdx; xor al,al`)
     * clears the low byte of a copy.  The frame now materializes the base and
     * then emits the lane constant move. */
    static const pl_u8 lane_constant_from_base[] = {
        0x48u, 0x89u, 0xd0u,                      /* mov rax, rdx       */
        0x30u, 0xc0u,                             /* xor al, al         */
        0xf6u, 0xc2u, 0x01u,                      /* test dl, 1         */
        0x0fu, 0x85u, 0x00u, 0x00u, 0x00u, 0x00u, /* jne .              */
    };
    pl_x86_native_candidates lane_constant_candidates;
    status = candidates_projected(
        lane_constant_from_base, sizeof lane_constant_from_base, 0x7ffffu,
        &lane_constant_candidates);
    if (status || lane_constant_candidates.count < 2u) {
        fprintf(stderr, "native x86 selection: RED (lane constant from base "
                "status=%d candidates=%u diagnostic=0x%x)\n",
                status, lane_constant_candidates.count,
                lane_constant_candidates.diagnostic.blocking_work);
        return 113;
    }
    /* A register permutation cycle whose temporary is itself a publication
     * (`mov rax,rdi; mov rdi,rsi; mov rsi,rax`).  measure_direct_frame's
     * "old value free" order deadlocks; the alias pass records that entry RDI
     * is now in RAX and reads it. */
    static const pl_u8 register_permutation[] = {
        0x48u, 0x89u, 0xf8u,                      /* mov rax, rdi       */
        0x48u, 0x89u, 0xf7u,                      /* mov rdi, rsi       */
        0x48u, 0x89u, 0xc6u,                      /* mov rsi, rax       */
    };
    pl_x86_native_candidates permutation_candidates;
    status = candidates_projected(
        register_permutation, sizeof register_permutation, 0x7ffffu,
        &permutation_candidates);
    if (status || permutation_candidates.count < 2u) {
        fprintf(stderr, "native x86 selection: RED (register permutation "
                "status=%d candidates=%u diagnostic=0x%x)\n",
                status, permutation_candidates.count,
                permutation_candidates.diagnostic.blocking_work);
        return 114;
    }
    pl_x86_block live_flags_block = { 0 };
    status = select_projected(
        live_flags_dead_value, sizeof live_flags_dead_value, 0x1ffffu,
        &selected, output, &written, &live_flags_block);
    if (status || !selected.supported || selected.copied_source
            || selected.output_work != 2u || selected.output_span != 1u
            || written != 9u
            || output[0] != 0x04u || output[1] != 0xc3u) {
        fprintf(stderr,
                "native x86 selection: RED (live flags/dead value "
                "status=%d source/alu/work/span/bytes="
                "%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span, written);
        print_block_shape(&live_flags_block);
        pl_x86_native_candidates live_flags_candidates = { 0 };
        int live_flags_status = candidates(
            live_flags_dead_value, sizeof live_flags_dead_value,
            0x1000u, &live_flags_candidates);
        fprintf(stderr, "  candidates status/count=%d/%u\n",
                live_flags_status, live_flags_candidates.count);
        for (pl_u32 index = 0u;
                index < live_flags_candidates.count; ++index)
            fprintf(stderr,
                    "  candidate[%u] source/alu/bytes/work/span="
                    "%u/%u/%u/%u/%u\n", index,
                    (unsigned)
                        live_flags_candidates.candidate[index].copied_source,
                    (unsigned)live_flags_candidates.candidate[index]
                        .direct_alu_frame,
                    live_flags_candidates.candidate[index].output_bytes,
                    live_flags_candidates.candidate[index].output_work,
                    live_flags_candidates.candidate[index].output_span);
        return 37;
    }
    pl_x86_block overwritten_copy_block = { 0 };
    status = select_projected(
        overwritten_copy_branch, sizeof overwritten_copy_branch, 0x1ffffu,
        &selected, output, &written, &overwritten_copy_block);
    if (status || !selected.supported
            || selected.copied_source || !(selected.direct_branch_frame || selected.direct_alu_frame)
            || selected.output_work != 5u || selected.output_span != 2u
            || selected.output_bytes != 15u
            || selected.omitted_prefix_bytes) {
        fprintf(stderr,
                "native x86 selection: RED (overwritten copy branch "
                "status=%d source/branch/work/span/bytes/omitted="
                "%u/%u/%u/%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_branch_frame,
                selected.output_work, selected.output_span, written,
                selected.omitted_prefix_bytes);
        print_block_shape(&overwritten_copy_block);
        pl_x86_native_candidates overwritten_candidates = { 0 };
        int overwritten_status = candidates(
            overwritten_copy_branch, sizeof overwritten_copy_branch,
            0x1000u, &overwritten_candidates);
        fprintf(stderr, "  candidates status/count=%d/%u\n",
                overwritten_status, overwritten_candidates.count);
        for (pl_u32 index = 0u;
                index < overwritten_candidates.count; ++index)
            fprintf(stderr,
                    "  candidate[%u] source/branch/bytes/work/span/omitted="
                    "%u/%u/%u/%u/%u/%u\n", index,
                    (unsigned)
                        overwritten_candidates.candidate[index].copied_source,
                    (unsigned)overwritten_candidates.candidate[index]
                        .direct_branch_frame,
                    overwritten_candidates.candidate[index].output_bytes,
                    overwritten_candidates.candidate[index].output_work,
                    overwritten_candidates.candidate[index].output_span,
                    overwritten_candidates.candidate[index]
                        .omitted_prefix_bytes);
        return 38;
    }
    pl_x86_native_candidates chained_candidates = { 0 };
    status = candidates(
        chained_affine_select, sizeof chained_affine_select,
        0x1000u, &chained_candidates);
    pl_u32 chained_span = 0u, chained_work = 0u;
    if (!status)
        status = pl_x86_candidates_select_joint_minimum(
            &chained_candidates, 0u, 0u, &selected,
            &chained_span, &chained_work);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_transient_owner_frame
            || selected.output_bytes != 31u
            || selected.output_work != 7u || selected.output_span != 5u) {
        fprintf(stderr,
                "native x86 selection: RED (chained affine select "
                "status=%d transient=%u bytes/work/span=%u/%u/%u "
                "minima=%u/%u candidates=%u)\n",
                status, (unsigned)selected.direct_transient_owner_frame,
                selected.output_bytes, selected.output_work,
                selected.output_span, chained_span, chained_work,
                chained_candidates.count);
        for (pl_u32 index = 0u;
                index < chained_candidates.count; ++index)
        {
            fprintf(stderr,
                    "  candidate[%u] source/frame/alu/bytes/work/span="
                    "%u/%u/%u/%u/%u/%u\n", index,
                    (unsigned)chained_candidates.candidate[index]
                        .copied_source,
                    (unsigned)chained_candidates.candidate[index]
                        .direct_frame,
                    (unsigned)chained_candidates.candidate[index]
                        .direct_alu_frame,
                    chained_candidates.candidate[index].output_bytes,
                    chained_candidates.candidate[index].output_work,
                    chained_candidates.candidate[index].output_span);
            pl_u8 diagnostic_bytes[64u];
            pl_u32 diagnostic_written = 0u;
            int diagnostic_status = write_candidate(
                chained_affine_select, sizeof chained_affine_select,
                0x1000u, &chained_candidates.candidate[index],
                diagnostic_bytes, sizeof diagnostic_bytes,
                &diagnostic_written);
            fprintf(stderr, "    emitted status/bytes=%d/%u:",
                    diagnostic_status, diagnostic_written);
            for (pl_u32 byte = 0u; byte < diagnostic_written; ++byte)
                fprintf(stderr, " %02x", diagnostic_bytes[byte]);
            fputc('\n', stderr);
        }
        return 39;
    }
    pl_x86_native_candidates increment_candidates = { 0 };
    status = candidates(
        independent_increment_branch, sizeof independent_increment_branch,
        0x1000u, &increment_candidates);
    pl_u32 increment_span = 0u, increment_work = 0u;
    if (!status)
        status = pl_x86_candidates_select_joint_minimum(
            &increment_candidates, 0u, 0u, &selected,
            &increment_span, &increment_work);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_live_frame
            || selected.output_bytes != 10u
            || selected.output_work != 4u || selected.output_span != 2u) {
        fprintf(stderr,
                "native x86 selection: RED (independent increment branch "
                "status=%d minima=%u/%u candidates=%u)\n",
                status, increment_span, increment_work,
                increment_candidates.count);
        for (pl_u32 index = 0u;
                index < increment_candidates.count; ++index)
            fprintf(stderr,
                    "  candidate[%u] source/branch/alu/live/bytes/work/span="
                    "%u/%u/%u/%u/%u/%u/%u\n", index,
                    (unsigned)increment_candidates.candidate[index]
                        .copied_source,
                    (unsigned)increment_candidates.candidate[index]
                        .direct_branch_frame,
                    (unsigned)increment_candidates.candidate[index]
                        .direct_alu_frame,
                    (unsigned)increment_candidates.candidate[index]
                        .direct_live_frame,
                    increment_candidates.candidate[index].output_bytes,
                    increment_candidates.candidate[index].output_work,
                    increment_candidates.candidate[index].output_span);
        return 40;
    }
    pl_x86_native_candidates zero_candidates = { 0 };
    status = candidates(
        overwritten_select_common_zero,
        sizeof overwritten_select_common_zero,
        0x1000u, &zero_candidates);
    pl_u32 zero_span = 0u, zero_work = 0u;
    if (!status)
        status = pl_x86_candidates_select_joint_minimum(
            &zero_candidates, 0u, 0u, &selected,
            &zero_span, &zero_work);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_zero_flag_frame
            || selected.output_bytes != 15u
            || selected.output_work != 5u || selected.output_span != 1u) {
        fprintf(stderr,
                "native x86 selection: RED (overwritten select common zero "
                "status=%d minima=%u/%u candidates=%u)\n",
                status, zero_span, zero_work, zero_candidates.count);
        pl_x86_block zero_block = { 0 };
        pl_x86_native_selection zero_selection = { 0 };
        pl_u32 zero_written = 0u;
        (void)select_projected(
            overwritten_select_common_zero,
            sizeof overwritten_select_common_zero,
            (1u << PL_X86_LOCAL_COUNT) - 1u,
            &zero_selection, output, &zero_written, &zero_block);
        print_block_shape(&zero_block);
        for (pl_u32 index = 0u; index < zero_candidates.count; ++index) {
            fprintf(stderr,
                    "  candidate[%u] source/common/alu/bytes/work/span="
                    "%u/%u/%u/%u/%u/%u\n", index,
                    (unsigned)zero_candidates.candidate[index].copied_source,
                    (unsigned)zero_candidates.candidate[index]
                        .direct_common_frame,
                    (unsigned)zero_candidates.candidate[index]
                        .direct_alu_frame,
                    zero_candidates.candidate[index].output_bytes,
                    zero_candidates.candidate[index].output_work,
                    zero_candidates.candidate[index].output_span);
            pl_u8 diagnostic_bytes[64u];
            pl_u32 diagnostic_written = 0u;
            int diagnostic_status = write_candidate(
                overwritten_select_common_zero,
                sizeof overwritten_select_common_zero, 0x1000u,
                &zero_candidates.candidate[index], diagnostic_bytes,
                sizeof diagnostic_bytes, &diagnostic_written);
            fprintf(stderr, "    emitted status/bytes=%d/%u:",
                    diagnostic_status, diagnostic_written);
            for (pl_u32 byte = 0u; byte < diagnostic_written; ++byte)
                fprintf(stderr, " %02x", diagnostic_bytes[byte]);
            fputc('\n', stderr);
        }
        return 41;
    }
    pl_x86_native_candidates shift_candidates = { 0 };
    status = candidates(
        paired_variable_shift, sizeof paired_variable_shift,
        0x1000u, &shift_candidates);
    pl_u32 paired_span = 0u, paired_work = 0u;
    if (!status)
        status = pl_x86_candidates_select_joint_minimum(
            &shift_candidates, 0u, 0u, &selected,
            &paired_span, &paired_work);
    if (status || !selected.supported || selected.copied_source
            || (!selected.direct_alu_frame
                && !selected.direct_live_frame)
            || selected.output_bytes != 19u
            || selected.output_work != 6u || selected.output_span != 2u) {
        fprintf(stderr,
                "native x86 selection: RED (paired variable shift "
                "status=%d minima=%u/%u candidates=%u)\n",
                status, paired_span, paired_work, shift_candidates.count);
        pl_x86_block shift_block = { 0 };
        pl_x86_native_selection shift_selection = { 0 };
        pl_u32 shift_written = 0u;
        (void)select_projected(
            paired_variable_shift, sizeof paired_variable_shift,
            (1u << PL_X86_LOCAL_COUNT) - 1u,
            &shift_selection, output, &shift_written, &shift_block);
        print_block_shape(&shift_block);
        for (pl_u32 index = 0u; index < shift_candidates.count; ++index) {
            fprintf(stderr,
                    "  candidate[%u] source/alu/shift/live/bytes/work/span="
                    "%u/%u/%u/%u/%u/%u/%u\n", index,
                    (unsigned)shift_candidates.candidate[index].copied_source,
                    (unsigned)shift_candidates.candidate[index]
                        .direct_alu_frame,
                    (unsigned)shift_candidates.candidate[index]
                        .direct_shift_frame,
                    (unsigned)shift_candidates.candidate[index]
                        .direct_live_frame,
                    shift_candidates.candidate[index].output_bytes,
                    shift_candidates.candidate[index].output_work,
                    shift_candidates.candidate[index].output_span);
            pl_u8 diagnostic_bytes[64u];
            pl_u32 diagnostic_written = 0u;
            int diagnostic_status = write_candidate(
                paired_variable_shift, sizeof paired_variable_shift,
                0x1000u, &shift_candidates.candidate[index],
                diagnostic_bytes, sizeof diagnostic_bytes,
                &diagnostic_written);
            fprintf(stderr, "    emitted status/bytes=%d/%u:",
                    diagnostic_status, diagnostic_written);
            for (pl_u32 byte = 0u; byte < diagnostic_written; ++byte)
                fprintf(stderr, " %02x", diagnostic_bytes[byte]);
            fputc('\n', stderr);
        }
        return 42;
    }
    pl_x86_native_candidates zero_shift_candidates = { 0 };
    status = candidates(
        zero_shift_publication, sizeof zero_shift_publication,
        0x1000u, &zero_shift_candidates);
    pl_u32 zero_shift_span = 0u, zero_shift_work = 0u;
    if (!status)
        status = pl_x86_candidates_select_joint_minimum(
            &zero_shift_candidates, 0u, 0u, &selected,
            &zero_shift_span, &zero_shift_work);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_zero_flag_frame
            || selected.output_bytes != 4u
            || selected.output_work != 2u || selected.output_span != 1u) {
        fprintf(stderr,
                "native x86 selection: RED (zero shift publication "
                "status=%d minima=%u/%u candidates=%u)\n",
                status, zero_shift_span, zero_shift_work,
                zero_shift_candidates.count);
        pl_x86_block zero_shift_block = { 0 };
        pl_x86_native_selection zero_shift_selection = { 0 };
        pl_u32 zero_shift_written = 0u;
        (void)select_projected(
            zero_shift_publication, sizeof zero_shift_publication,
            (1u << PL_X86_LOCAL_COUNT) - 1u,
            &zero_shift_selection, output, &zero_shift_written,
            &zero_shift_block);
        print_block_shape(&zero_shift_block);
        for (pl_u32 index = 0u;
                index < zero_shift_candidates.count; ++index) {
            fprintf(stderr,
                    "  candidate[%u] source/alu/zero/bytes/work/span="
                    "%u/%u/%u/%u/%u/%u\n", index,
                    (unsigned)zero_shift_candidates.candidate[index]
                        .copied_source,
                    (unsigned)zero_shift_candidates.candidate[index]
                        .direct_alu_frame,
                    (unsigned)zero_shift_candidates.candidate[index]
                        .direct_zero_flag_frame,
                    zero_shift_candidates.candidate[index].output_bytes,
                    zero_shift_candidates.candidate[index].output_work,
                    zero_shift_candidates.candidate[index].output_span);
            pl_u8 diagnostic_bytes[64u];
            pl_u32 diagnostic_written = 0u;
            int diagnostic_status = write_candidate(
                zero_shift_publication, sizeof zero_shift_publication,
                0x1000u, &zero_shift_candidates.candidate[index],
                diagnostic_bytes, sizeof diagnostic_bytes,
                &diagnostic_written);
            fprintf(stderr, "    emitted status/bytes=%d/%u:",
                    diagnostic_status, diagnostic_written);
            for (pl_u32 byte = 0u; byte < diagnostic_written; ++byte)
                fprintf(stderr, " %02x", diagnostic_bytes[byte]);
            fputc('\n', stderr);
        }
        return 43;
    }
    pl_x86_native_candidates shared_add_candidates = { 0 };
    status = candidates(
        shared_add_after_shift, sizeof shared_add_after_shift,
        0x1000u, &shared_add_candidates);
    pl_u32 shared_add_span = 0u, shared_add_work = 0u;
    if (!status)
        status = pl_x86_candidates_select_joint_minimum(
            &shared_add_candidates, 0u, 0u, &selected,
            &shared_add_span, &shared_add_work);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_bytes != 14u
            || selected.output_work != 4u || selected.output_span != 1u) {
        fprintf(stderr,
                "native x86 selection: RED (shared add after shift "
                "status=%d minima=%u/%u candidates=%u)\n",
                status, shared_add_span, shared_add_work,
                shared_add_candidates.count);
        for (pl_u32 index = 0u;
                index < shared_add_candidates.count; ++index) {
            fprintf(stderr,
                    "  candidate[%u] source/alu/shared/bytes/work/span="
                    "%u/%u/%u/%u/%u/%u\n", index,
                    (unsigned)shared_add_candidates.candidate[index]
                        .copied_source,
                    (unsigned)shared_add_candidates.candidate[index]
                        .direct_alu_frame,
                    (unsigned)shared_add_candidates.candidate[index]
                        .direct_shared_owner_frame,
                    shared_add_candidates.candidate[index].output_bytes,
                    shared_add_candidates.candidate[index].output_work,
                    shared_add_candidates.candidate[index].output_span);
            pl_u8 diagnostic_bytes[64u];
            pl_u32 diagnostic_written = 0u;
            int diagnostic_status = write_candidate(
                shared_add_after_shift, sizeof shared_add_after_shift,
                0x1000u, &shared_add_candidates.candidate[index],
                diagnostic_bytes, sizeof diagnostic_bytes,
                &diagnostic_written);
            fprintf(stderr, "    emitted status/bytes=%d/%u:",
                    diagnostic_status, diagnostic_written);
            for (pl_u32 byte = 0u; byte < diagnostic_written; ++byte)
                fprintf(stderr, " %02x", diagnostic_bytes[byte]);
            fputc('\n', stderr);
        }
        return 44;
    }
    pl_x86_native_candidates live_select_candidates = { 0 };
    status = candidates(
        live_select_common_zero, sizeof live_select_common_zero,
        0x1000u, &live_select_candidates);
    pl_u32 live_select_span = 0u, live_select_work = 0u;
    if (!status)
        status = pl_x86_candidates_select_joint_minimum(
            &live_select_candidates, 0u, 0u, &selected,
            &live_select_span, &live_select_work);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_bytes != 20u
            || selected.output_work != 6u || selected.output_span != 1u) {
        fprintf(stderr,
                "native x86 selection: RED (live select common zero "
                "status=%d minima=%u/%u candidates=%u)\n",
                status, live_select_span, live_select_work,
                live_select_candidates.count);
        pl_x86_block live_select_block = { 0 };
        pl_x86_native_selection live_select_selection = { 0 };
        pl_u32 live_select_written = 0u;
        (void)select_projected(
            live_select_common_zero, sizeof live_select_common_zero,
            (1u << PL_X86_LOCAL_COUNT) - 1u,
            &live_select_selection, output, &live_select_written,
            &live_select_block);
        print_block_shape(&live_select_block);
        for (pl_u32 index = 0u;
                index < live_select_candidates.count; ++index) {
            fprintf(stderr,
                    "  candidate[%u] source/alu/zero/bytes/work/span="
                    "%u/%u/%u/%u/%u/%u\n", index,
                    (unsigned)live_select_candidates.candidate[index]
                        .copied_source,
                    (unsigned)live_select_candidates.candidate[index]
                        .direct_alu_frame,
                    (unsigned)live_select_candidates.candidate[index]
                        .direct_zero_flag_frame,
                    live_select_candidates.candidate[index].output_bytes,
                    live_select_candidates.candidate[index].output_work,
                    live_select_candidates.candidate[index].output_span);
            pl_u8 diagnostic_bytes[64u];
            pl_u32 diagnostic_written = 0u;
            int diagnostic_status = write_candidate(
                live_select_common_zero, sizeof live_select_common_zero,
                0x1000u, &live_select_candidates.candidate[index],
                diagnostic_bytes, sizeof diagnostic_bytes,
                &diagnostic_written);
            fprintf(stderr, "    emitted status/bytes=%d/%u:",
                    diagnostic_status, diagnostic_written);
            for (pl_u32 byte = 0u; byte < diagnostic_written; ++byte)
                fprintf(stderr, " %02x", diagnostic_bytes[byte]);
            fputc('\n', stderr);
        }
        return 45;
    }
    pl_x86_native_candidates plus_one_candidates = { 0 };
    status = candidates(
        zero_plus_one_publications, sizeof zero_plus_one_publications,
        0x1000u, &plus_one_candidates);
    pl_u32 plus_one_span = 0u, plus_one_work = 0u;
    if (!status)
        status = pl_x86_candidates_select_joint_minimum(
            &plus_one_candidates, 0u, 0u, &selected,
            &plus_one_span, &plus_one_work);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_zero_flag_frame
            || selected.output_bytes != 9u
            || selected.output_work != 3u || selected.output_span != 1u) {
        fprintf(stderr,
                "native x86 selection: RED (zero plus one publications "
                "status=%d minima=%u/%u candidates=%u)\n",
                status, plus_one_span, plus_one_work,
                plus_one_candidates.count);
        for (pl_u32 index = 0u;
                index < plus_one_candidates.count; ++index) {
            fprintf(stderr,
                    "  candidate[%u] source/alu/zero/bytes/work/span="
                    "%u/%u/%u/%u/%u/%u\n", index,
                    (unsigned)plus_one_candidates.candidate[index]
                        .copied_source,
                    (unsigned)plus_one_candidates.candidate[index]
                        .direct_alu_frame,
                    (unsigned)plus_one_candidates.candidate[index]
                        .direct_zero_flag_frame,
                    plus_one_candidates.candidate[index].output_bytes,
                    plus_one_candidates.candidate[index].output_work,
                    plus_one_candidates.candidate[index].output_span);
            pl_u8 diagnostic_bytes[64u];
            pl_u32 diagnostic_written = 0u;
            int diagnostic_status = write_candidate(
                zero_plus_one_publications,
                sizeof zero_plus_one_publications,
                0x1000u, &plus_one_candidates.candidate[index],
                diagnostic_bytes, sizeof diagnostic_bytes,
                &diagnostic_written);
            fprintf(stderr, "    emitted status/bytes=%d/%u:",
                    diagnostic_status, diagnostic_written);
            for (pl_u32 byte = 0u; byte < diagnostic_written; ++byte)
                fprintf(stderr, " %02x", diagnostic_bytes[byte]);
            fputc('\n', stderr);
        }
        return 46;
    }
    pl_x86_native_candidates shift_copy_candidates = { 0 };
    status = candidates(
        shift_copy_overwrite_jump, sizeof shift_copy_overwrite_jump,
        0x1000u, &shift_copy_candidates);
    pl_u32 shift_copy_span = 0u, shift_copy_work = 0u;
    if (!status)
        status = pl_x86_candidates_select_joint_minimum(
            &shift_copy_candidates, 0u, 0u, &selected,
            &shift_copy_span, &shift_copy_work);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_shift_handoff_frame
            || selected.output_bytes != 18u
            || selected.output_work != 5u || selected.output_span != 2u) {
        fprintf(stderr,
                "native x86 selection: RED (shift copy overwrite jump "
                "status=%d minima=%u/%u candidates=%u)\n",
                status, shift_copy_span, shift_copy_work,
                shift_copy_candidates.count);
        pl_x86_block shift_copy_block = { 0 };
        pl_x86_native_selection shift_copy_selection = { 0 };
        pl_u32 shift_copy_written = 0u;
        (void)select_projected(
            shift_copy_overwrite_jump, sizeof shift_copy_overwrite_jump,
            (1u << PL_X86_LOCAL_COUNT) - 1u,
            &shift_copy_selection, output, &shift_copy_written,
            &shift_copy_block);
        print_block_shape(&shift_copy_block);
        for (pl_u32 index = 0u;
                index < shift_copy_candidates.count; ++index) {
            const pl_x86_native_selection *candidate =
                &shift_copy_candidates.candidate[index];
            fprintf(stderr,
                    "  candidate[%u] source/alu/bytes/work/span="
                    "%u/%u/%u/%u/%u\n", index,
                    (unsigned)candidate->copied_source,
                    (unsigned)candidate->direct_alu_frame,
                    candidate->output_bytes, candidate->output_work,
                    candidate->output_span);
            pl_u8 diagnostic_bytes[64u];
            pl_u32 diagnostic_written = 0u;
            int diagnostic_status = write_candidate(
                shift_copy_overwrite_jump,
                sizeof shift_copy_overwrite_jump, 0x1000u,
                candidate, diagnostic_bytes, sizeof diagnostic_bytes,
                &diagnostic_written);
            fprintf(stderr, "    emitted status/bytes=%d/%u:",
                    diagnostic_status, diagnostic_written);
            for (pl_u32 byte = 0u; byte < diagnostic_written; ++byte)
                fprintf(stderr, " %02x", diagnostic_bytes[byte]);
            fputc('\n', stderr);
        }
        return 47;
    }
    pl_x86_native_candidates constant_shift_candidates = { 0 };
    status = candidates(
        constant_and_shift, sizeof constant_and_shift,
        0x1000u, &constant_shift_candidates);
    pl_u32 constant_shift_span = 0u, constant_shift_work = 0u;
    if (!status)
        status = pl_x86_candidates_select_joint_minimum(
            &constant_shift_candidates, 0u, 0u, &selected,
            &constant_shift_span, &constant_shift_work);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.direct_shift_handoff_frame
            || selected.output_bytes != 14u
            || selected.output_work != 3u || selected.output_span != 2u) {
        fprintf(stderr,
                "native x86 selection: RED (constant and shift "
                "status=%d minima=%u/%u candidates=%u)\n",
                status, constant_shift_span, constant_shift_work,
                constant_shift_candidates.count);
        pl_x86_block constant_shift_block = { 0 };
        pl_x86_native_selection constant_shift_selection = { 0 };
        pl_u32 constant_shift_written = 0u;
        (void)select_projected(
            constant_and_shift, sizeof constant_and_shift,
            (1u << PL_X86_LOCAL_COUNT) - 1u,
            &constant_shift_selection, output, &constant_shift_written,
            &constant_shift_block);
        print_block_shape(&constant_shift_block);
        for (pl_u32 index = 0u;
                index < constant_shift_candidates.count; ++index) {
            const pl_x86_native_selection *candidate =
                &constant_shift_candidates.candidate[index];
            fprintf(stderr,
                    "  candidate[%u] source/alu/handoff/bytes/work/span="
                    "%u/%u/%u/%u/%u/%u\n", index,
                    (unsigned)candidate->copied_source,
                    (unsigned)candidate->direct_alu_frame,
                    (unsigned)candidate->direct_shift_handoff_frame,
                    candidate->output_bytes, candidate->output_work,
                    candidate->output_span);
            pl_u8 diagnostic_bytes[64u];
            pl_u32 diagnostic_written = 0u;
            int diagnostic_status = write_candidate(
                constant_and_shift, sizeof constant_and_shift, 0x1000u,
                candidate, diagnostic_bytes, sizeof diagnostic_bytes,
                &diagnostic_written);
            fprintf(stderr, "    emitted status/bytes=%d/%u:",
                    diagnostic_status, diagnostic_written);
            for (pl_u32 byte = 0u; byte < diagnostic_written; ++byte)
                fprintf(stderr, " %02x", diagnostic_bytes[byte]);
            fputc('\n', stderr);
        }
        return 48;
    }
    pl_u32 live_without_flags = (1u << PL_X86_LOCAL_COUNT) - 1u;
    live_without_flags &= ~(1u << PL_X86_RFLAGS_LOCAL);
    pl_x86_block projected = { 0 };
    status = select_projected(
        equal_address_dead_compare, sizeof equal_address_dead_compare,
        live_without_flags, &selected, output, &written, &projected);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame || selected.output_work != 3u
            || selected.output_span != 2u || written != 12u
            || projected.plan.node_count) {
        fprintf(stderr,
                "native x86 selection: RED (future common status=%d "
                "supported/copied/common=%u/%u/%u work/span=%u/%u "
                "bytes=%u)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                (unsigned)selected.direct_common_frame,
                selected.output_work, selected.output_span, written);
        print_block_shape(&projected);
        return 21;
    }
    projected = (pl_x86_block){ 0 };
    status = select_projected(
        equal_address_dead_compare,
        sizeof equal_address_dead_compare, 1u << 7u,
        &selected, output, &written, &projected);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame || selected.direct_common_frame
            || selected.fixup_count != 3u
            || selected.fixups[0].source_at != 3u
            || selected.fixups[1].source_at != 10u
            || selected.fixups[0].source_bytes != 4u
            || selected.fixups[1].source_bytes != 4u
            || selected.fixups[0].at != selected.fixups[1].at
            || selected.fixups[0].target != 0x1020u
            || selected.fixups[1].target != 0x1020u
            || selected.output_work != 2u
            || selected.output_span != 2u || written != 9u
            || projected.plan.node_count) {
        fprintf(stderr,
                "native x86 selection: RED (generic address alias "
                "status=%d supported/copied/common=%u/%u/%u "
                "fixups=%u source=%u/%u output=%u/%u target=%llx/%llx "
                "work/span/bytes=%u/%u/%u)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                (unsigned)selected.direct_common_frame,
                selected.fixup_count,
                selected.fixups[0].source_at,
                selected.fixups[1].source_at,
                selected.fixups[0].at,
                selected.fixups[1].at,
                (unsigned long long)selected.fixups[0].target,
                (unsigned long long)selected.fixups[1].target,
                selected.output_work, selected.output_span, written);
        print_block_shape(&projected);
        return 112;
    }
    pl_u32 abi_return_outputs =
        (1u << 0u) | (1u << 2u) | (1u << 3u)
      | (1u << 4u) | (1u << 5u)
      | (1u << 12u) | (1u << 13u) | (1u << 14u) | (1u << 15u)
      | (1u << PL_X86_FS_BASE_LOCAL)
      | (1u << PL_X86_GS_BASE_LOCAL);
    projected = (pl_x86_block){ 0 };
    status = select_projected(
        inverse_stack_adjust, sizeof inverse_stack_adjust,
        abi_return_outputs, &selected, output, &written, &projected);
    if (status || !selected.supported || selected.copied_source
            || selected.output_work || selected.output_span || written
            || projected.plan.node_count) {
        fprintf(stderr,
                "native x86 selection: RED (inverse stack status=%d "
                "supported/copied=%u/%u work/span=%u/%u bytes=%u)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                selected.output_work, selected.output_span, written);
        print_block_shape(&projected);
        return 22;
    }
    status = select(
        redundant, sizeof redundant, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || selected.source_bytes != 2u || selected.output_bytes
            || selected.eliminated_bytes != 2u || written) {
        fprintf(stderr,
                "native x86 selection: RED (identity status=%d supported=%u "
                "copied=%u source/output/eliminated=%u/%u/%u written=%u "
                "byte=%02x)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source, selected.source_bytes,
                selected.output_bytes, selected.eliminated_bytes, written,
                (unsigned)output[0]);
        return 1;
    }

    status = select(
        redundant, sizeof redundant, 0x1002u,
        &selected, output, &written);
    if (status || !selected.supported || !selected.copied_source
            || selected.source_bytes != 1u || selected.output_bytes != 1u
            || selected.eliminated_bytes || written != 1u
            || output[0] != 0xc3u) {
        fprintf(stderr,
                "native x86 selection: RED (terminal status=%d supported=%u "
                "copied=%u source/output/eliminated=%u/%u/%u written=%u "
                "byte=%02x)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source, selected.source_bytes,
                selected.output_bytes, selected.eliminated_bytes, written,
                (unsigned)output[0]);
        return 2;
    }

    status = select_relaxed(
        relative, sizeof relative, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_live_frame
            || selected.fixup_count != 1u
            || selected.fixups[0].kind
               != PL_X86_NATIVE_FIXUP_PC_RELATIVE
            || selected.fixups[0].at != 1u
            || selected.fixups[0].next_ip_at != 5u
            || selected.fixups[0].bytes != 4u
            || selected.fixups[0].target != 0x1000u
            || selected.source_bytes != 3u || selected.output_bytes != 5u
            || written != 5u || output[0] != 0xe9u || output[1]
            || output[2] || output[3] || output[4]) {
        fprintf(stderr,
                "native x86 selection: RED (relative status=%d supported=%u "
                "fixup=%u/%u@%u target=0x%llx source/output=%u/%u "
                "written=%u opcode=%02x)\n", status,
                (unsigned)selected.supported,
                (unsigned)selected.fixups[0].kind,
                (unsigned)selected.fixups[0].bytes, selected.fixups[0].at,
                (unsigned long long)selected.fixups[0].target,
                selected.source_bytes, selected.output_bytes, written,
                (unsigned)output[0]);
        return 3;
    }
    status = pl_x86_select_bind_fixup(
        output, written, &selected, 0u, 0x2000u, 0x2000u);
    if (status || output[1] != 0xfbu || output[2] != 0xffu
            || output[3] != 0xffu || output[4] != 0xffu) {
        fprintf(stderr, "native x86 selection: RED (JMP bind status=%d)\n",
                status);
        return 4;
    }

    status = select_relaxed(
        short_conditional, sizeof short_conditional, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || !selected.copied_source
            || selected.fixup_count != 1u
            || selected.fixups[0].kind
               != PL_X86_NATIVE_FIXUP_PC_RELATIVE
            || selected.fixups[0].at != 2u
            || selected.fixups[0].next_ip_at != 6u
            || selected.fixups[0].bytes != 4u
            || selected.fixups[0].target != 0x1000u
            || selected.source_bytes != 2u || selected.output_bytes != 6u
            || written != 6u || output[0] != 0x0fu
            || output[1] != 0x87u || output[2] || output[3]
            || output[4] || output[5]) {
        fprintf(stderr,
                "native x86 selection: RED (near Jcc status=%d "
                "fixups=%u source/output=%u/%u written=%u)\n",
                status, selected.fixup_count, selected.source_bytes,
                selected.output_bytes, written);
        return 19;
    }
    status = pl_x86_select_bind_fixup(
        output, written, &selected, 0u, 0x2000u, 0x2000u);
    if (status || output[2] != 0xfau || output[3] != 0xffu
            || output[4] != 0xffu || output[5] != 0xffu) {
        fprintf(stderr,
                "native x86 selection: RED (Jcc bind status=%d)\n",
                status);
        return 20;
    }

    status = select(
        stateful, sizeof stateful, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame || !selected.direct_alu_frame
            || selected.fixup_count || selected.source_bytes != 4u
            || selected.output_bytes != 4u || written != 4u
            || output[0] != 0x48u || output[1] != 0x83u
            || output[2] != 0xc0u || output[3] != 0x01u) {
        fprintf(stderr,
                "native x86 selection: RED (stateful status=%d supported=%u "
                "copied/frame/alu=%u/%u/%u fixups=%u "
                "source/output=%u/%u written=%u)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame,
                (unsigned)selected.direct_alu_frame,
                selected.fixup_count,
                selected.source_bytes, selected.output_bytes, written);
        return 5;
    }

    status = select(
        identity_then_stateful, sizeof identity_then_stateful, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame || !selected.direct_alu_frame
            || selected.omitted_prefix_bytes
            || selected.source_bytes != 5u
            || selected.output_bytes != 4u
            || selected.eliminated_bytes != 1u || written != 4u
            || output[0] != 0x48u || output[1] != 0x83u
            || output[2] != 0xc0u || output[3] != 0x01u) {
        fprintf(stderr,
                "native x86 selection: RED (leading identity status=%d "
                "supported=%u source/frame/alu=%u/%u/%u omitted=%u "
                "source/output/eliminated=%u/%u/%u "
                "written=%u)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame,
                (unsigned)selected.direct_alu_frame,
                selected.omitted_prefix_bytes, selected.source_bytes,
                selected.output_bytes, selected.eliminated_bytes, written);
        return 6;
    }

    status = select(
        noncanonical_add, sizeof noncanonical_add, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame || !selected.direct_alu_frame
            || selected.source_bytes != 7u || selected.output_bytes != 4u
            || selected.output_instructions != 1u
            || selected.eliminated_bytes != 3u || written != 4u
            || output[0] != 0x48u || output[1] != 0x83u
            || output[2] != 0xc0u || output[3] != 0x01u) {
        fprintf(stderr,
                "native x86 selection: RED (canonical ALU status=%d "
                "supported=%u source/frame/alu=%u/%u/%u "
                "source/output/work=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame,
                (unsigned)selected.direct_alu_frame,
                selected.source_bytes, selected.output_bytes,
                selected.output_instructions, written);
        return 17;
    }
    pl_x86_native_candidates alternatives;
    status = candidates(
        noncanonical_add, sizeof noncanonical_add, 0x1000u,
        &alternatives);
    if (status || alternatives.count != 2u
            || !alternatives.candidate[0].direct_frame
            || !alternatives.candidate[1].copied_source
            || alternatives.candidate[0].output_span != 1u
            || alternatives.candidate[1].output_span != 1u
            || alternatives.candidate[0].output_bytes != 4u
            || alternatives.candidate[1].output_bytes != 7u) {
        fprintf(stderr,
                "native x86 selection: RED (candidate frontier status=%d "
                "count=%u direct/source=%u/%u span=%u/%u bytes=%u/%u)\n",
                status, alternatives.count,
                (unsigned)alternatives.candidate[0].direct_frame,
                (unsigned)alternatives.candidate[1].copied_source,
                alternatives.candidate[0].output_span,
                alternatives.candidate[1].output_span,
                alternatives.candidate[0].output_bytes,
                alternatives.candidate[1].output_bytes);
        return 170;
    }

    status = candidates_with_relax(
        aligned_successor_compare, sizeof aligned_successor_compare,
        0x1000u, 1, &alternatives);
    pl_x86_native_selection joint = { 0 };
    pl_u32 joint_span = 0u, joint_work = 0u;
    if (!status)
        status = pl_x86_candidates_select_joint_minimum(
            &alternatives, 0u, 0u, &joint, &joint_span, &joint_work);
    if (status || joint_span != 4u || joint_work != 5u
            || joint.output_bytes != 20u || joint.copied_source) {
        fprintf(stderr,
                "native x86 selection: RED (shared owner status=%d "
                "count=%u minimum=%u/%u selected-bytes/source=%u/%u)\n",
                status, alternatives.count, joint_span, joint_work,
                joint.output_bytes, (unsigned)joint.copied_source);
        for (pl_u32 index = 0u; index < alternatives.count; ++index) {
            const pl_x86_native_selection *candidate =
                &alternatives.candidate[index];
            fprintf(stderr,
                    "  candidate[%u] span/work/bytes=%u/%u/%u "
                    "source/branch/alu=%u/%u/%u\n",
                    index, candidate->output_span, candidate->output_work,
                    candidate->output_bytes,
                    (unsigned)candidate->copied_source,
                    (unsigned)candidate->direct_branch_frame,
                    (unsigned)candidate->direct_alu_frame);
        }
        (void)select_projected(
            aligned_successor_compare, sizeof aligned_successor_compare,
            (1u << PL_X86_LOCAL_COUNT) - 1u,
            &selected, output, &written, &projected);
        print_block_shape(&projected);
        return 171;
    }
    projected = (pl_x86_block){ 0 };
    pl_u32 load_successor_live =
        ((1u << PL_X86_LOCAL_COUNT) - 1u)
        & ~(1u << 1u) & ~(1u << PL_X86_RFLAGS_LOCAL);
    status = select_projected(
        shared_low_bit, sizeof shared_low_bit,
        load_successor_live, &selected, output, &written, &projected);
    if (status || !selected.supported || selected.copied_source
            || selected.output_work != 3u || selected.output_span != 3u) {
        fprintf(stderr,
                "native x86 selection: RED (projected shared owner "
                "status=%d source=%u work/span/bytes=%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                selected.output_work, selected.output_span, written);
        print_block_shape(&projected);
        return 172;
    }
    status = candidates(
        cancelled_affine_compare, sizeof cancelled_affine_compare,
        0x1000u, &alternatives);
    joint = (pl_x86_native_selection){ 0 };
    joint_span = joint_work = 0u;
    if (!status)
        status = pl_x86_candidates_select_joint_minimum(
            &alternatives, 0u, 0u, &joint, &joint_span, &joint_work);
    if (status || joint_span != 4u || joint_work != 7u
            || joint.copied_source) {
        fprintf(stderr,
                "native x86 selection: RED (cancelled affine status=%d "
                "count=%u minimum=%u/%u selected-bytes/source=%u/%u)\n",
                status, alternatives.count, joint_span, joint_work,
                joint.output_bytes, (unsigned)joint.copied_source);
        for (pl_u32 index = 0u; index < alternatives.count; ++index) {
            const pl_x86_native_selection *candidate =
                &alternatives.candidate[index];
            fprintf(stderr,
                    "  candidate[%u] span/work/bytes=%u/%u/%u "
                    "source/branch/alu=%u/%u/%u\n",
                    index, candidate->output_span, candidate->output_work,
                    candidate->output_bytes,
                    (unsigned)candidate->copied_source,
                    (unsigned)candidate->direct_branch_frame,
                    (unsigned)candidate->direct_alu_frame);
        }
        (void)select_projected(
            cancelled_affine_compare, sizeof cancelled_affine_compare,
            (1u << PL_X86_LOCAL_COUNT) - 1u,
            &selected, output, &written, &projected);
        print_block_shape(&projected);
        return 173;
    }
    projected = (pl_x86_block){ 0 };
    status = select_projected(
        zero_idiom_after_affine, sizeof zero_idiom_after_affine,
        0x7ffb5u, &selected, output, &written, &projected);
    if (status || !selected.supported || selected.copied_source
            || selected.output_work != 2u || selected.output_span != 1u
            || written != 5u) {
        fprintf(stderr,
                "native x86 selection: RED (zero idiom frame status=%d "
                "source=%u work/span/bytes=%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                selected.output_work, selected.output_span, written);
        print_block_shape(&projected);
        return 174;
    }

    /* Local lexicographic selection is not the whole-ELF optimum.  Block B
     * fixes global span at three, so block A may use its span-three one-byte
     * spelling instead of retaining its locally minimal span-two 100-byte
     * spelling.  The three streaming candidate passes must preserve it. */
    pl_x86_native_candidates block_a = { 0 };
    pl_x86_native_candidates block_b = { 0 };
    block_a.count = 2u;
    block_a.candidate[0] = (pl_x86_native_selection){
        .output_bytes = 100u, .output_work = 4u, .output_span = 2u,
        .supported = 1u,
    };
    block_a.candidate[1] = (pl_x86_native_selection){
        .output_bytes = 1u, .output_work = 4u, .output_span = 3u,
        .supported = 1u,
    };
    block_b.count = 1u;
    block_b.candidate[0] = (pl_x86_native_selection){
        .output_bytes = 1u, .output_work = 5u, .output_span = 3u,
        .supported = 1u,
    };
    pl_u32 a_span = 0u, b_span = 0u, a_work = 0u, b_work = 0u;
    status = pl_x86_candidates_minimum_span(&block_a, 0u, &a_span);
    if (!status)
        status = pl_x86_candidates_minimum_span(&block_b, 0u, &b_span);
    pl_u32 global_span = a_span > b_span ? a_span : b_span;
    if (!status)
        status = pl_x86_candidates_minimum_work(
            &block_a, 0u, 0u, 0xffffffffu, &a_work);
    if (!status)
        status = pl_x86_candidates_minimum_work(
            &block_b, 0u, 0u, 0xffffffffu, &b_work);
    pl_u32 global_work = a_work > b_work ? a_work : b_work;
    pl_x86_native_selection global_a = { 0 };
    if (!status)
        status = pl_x86_candidates_select_under(
            &block_a, 0u, 0u, global_span, global_work, &global_a);
    if (status || global_span != 3u || global_work != 5u
            || global_a.output_bytes != 1u
            || global_a.output_span != 3u) {
        fprintf(stderr,
                "native x86 selection: RED (global ceilings status=%d "
                "span/work=%u/%u A=%u bytes/%u span)\n",
                status, global_span, global_work,
                global_a.output_bytes, global_a.output_span);
        return 171;
    }
    pl_x86_native_candidates tradeoff = { 0 };
    tradeoff.count = 2u;
    tradeoff.candidate[0] = (pl_x86_native_selection){
        .output_bytes = 1u, .output_work = 3u, .output_span = 1u,
        .supported = 1u,
    };
    tradeoff.candidate[1] = (pl_x86_native_selection){
        .output_bytes = 1u, .output_work = 2u, .output_span = 2u,
        .supported = 1u,
    };
    pl_u32 least_span = 0u, least_work = 0u;
    status = pl_x86_candidates_minimum_span(
        &tradeoff, 0u, &least_span);
    if (!status)
        status = pl_x86_candidates_minimum_work(
            &tradeoff, 0u, 0u, 0xffffffffu, &least_work);
    pl_x86_native_selection impossible = { 0 };
    if (!status && !pl_x86_candidates_select_under(
            &tradeoff, 0u, 0u,
            least_span, least_work, &impossible))
        status = PL_ERROR_X86_SELECT;
    if (status || least_span != 1u || least_work != 2u) {
        fprintf(stderr,
                "native x86 selection: RED (physical tradeoff status=%d "
                "minimum span/work=%u/%u)\n",
                status, least_span, least_work);
        return 172;
    }

    status = select(
        noncanonical_insert32, sizeof noncanonical_insert32, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame || !selected.direct_insert_frame
            || selected.source_bytes != 3u || selected.output_bytes != 2u
            || selected.output_instructions != 1u
            || selected.eliminated_bytes != 1u || written != 2u
            || output[0] != 0x89u || output[1] != 0xe5u) {
        fprintf(stderr,
                "native x86 selection: RED (32-bit publication status=%d "
                "supported=%u source/frame/insert=%u/%u/%u "
                "source/output/work=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame,
                (unsigned)selected.direct_insert_frame,
                selected.source_bytes, selected.output_bytes,
                selected.output_instructions, written);
        return 18;
    }

    status = select(
        rip_relative, sizeof rip_relative, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame
            || selected.fixup_count != 1u
            || selected.fixups[0].kind
               != PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT
            || selected.fixups[0].at != 3u
            || selected.fixups[0].next_ip_at != 7u
            || selected.fixups[0].source_at != 3u
            || selected.fixups[0].source_bytes != 4u
            || selected.fixups[0].target != 0x1007u
            || selected.source_bytes != 7u || selected.output_bytes != 7u
            || written != 7u) {
        fprintf(stderr,
                "native x86 selection: RED (RIP status=%d supported=%u "
                "source/frame=%u/%u fixups=%u kind/at/next=%u/%u/%u target=0x%llx "
                "source/output=%u/%u written=%u)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame, selected.fixup_count,
                (unsigned)selected.fixups[0].kind, selected.fixups[0].at,
                selected.fixups[0].next_ip_at,
                (unsigned long long)selected.fixups[0].target,
                selected.source_bytes, selected.output_bytes, written);
        return 7;
    }
    status = pl_x86_select_bind_fixup(
        output, written, &selected, 0u, 0x2000u, 0x1007u);
    if (status || output[3] != 0x00u || output[4] != 0xf0u
            || output[5] != 0xffu || output[6] != 0xffu) {
        fprintf(stderr, "native x86 selection: RED (RIP bind status=%d)\n",
                status);
        return 8;
    }
    status = select(
        overwritten_prefix, sizeof overwritten_prefix, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame
            || selected.omitted_prefix_bytes
            || selected.source_bytes != 10u
            || selected.output_bytes != 5u
            || selected.eliminated_bytes != 5u || written != 5u
            || output[0] != 0xb8u || output[1] != 0x07u) {
        fprintf(stderr,
                "native x86 selection: RED (overwritten prefix status=%d "
                "supported=%u omitted=%u source/output/eliminated=%u/%u/%u "
                "written=%u)\n",
                status, (unsigned)selected.supported,
                selected.omitted_prefix_bytes, selected.source_bytes,
                selected.output_bytes, selected.eliminated_bytes, written);
        return 9;
    }
    status = select(
        noncontiguous_overwrite, sizeof noncontiguous_overwrite, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame
            || selected.source_bytes != 20u
            || selected.output_bytes != 15u
            || selected.output_instructions != 3u
            || selected.output_work != 3u || selected.output_span != 1u
            || selected.eliminated_bytes != 5u || written != 15u
            || output[0] != 0xb8u || output[1] != 0x07u
            || output[5] != 0xb9u || output[6] != 0x03u
            || output[10] != 0xbbu || output[11] != 0x02u) {
        fprintf(stderr,
                "native x86 selection: RED (noncontiguous overwrite status=%d "
                "supported=%u copied=%u source/output/work=%u/%u/%u "
                "written=%u bytes=%02x/%02x)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source, selected.source_bytes,
                selected.output_bytes, selected.output_instructions, written,
                (unsigned)output[0], (unsigned)output[5]);
        return 10;
    }
    status = select_with_fields(
        noncontiguous_overwrite, sizeof noncontiguous_overwrite,
        0x1000u, 1, 0, &selected, output, &written);
    /* Construction history is not an instruction-selection constraint.  A
     * real relocation must later match an exact synthesized field binding or
     * publication fails; it must not force the whole source spelling here. */
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame || selected.output_bytes != 15u
            || selected.output_instructions != 3u || written != 15u) {
        fprintf(stderr,
                "native x86 selection: RED (construction field status=%d "
                "supported=%u copied/frame=%u/%u output/work=%u/%u)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame, selected.output_bytes,
                selected.output_instructions);
        return 110;
    }
    pl_x86_native_candidates live_candidates = { 0 };
    status = candidates(
        cyclic_copy_with_dead_middle,
        sizeof cyclic_copy_with_dead_middle, 0x1000u,
        &live_candidates);
    const pl_x86_native_selection *live_candidate = NULL;
    for (pl_u32 index = 0u; !status && index < live_candidates.count;
            ++index)
        if (live_candidates.candidate[index].direct_live_frame) {
            live_candidate = &live_candidates.candidate[index];
            break;
        }
    if (!status && live_candidate)
        status = write_candidate(
            cyclic_copy_with_dead_middle,
            sizeof cyclic_copy_with_dead_middle, 0x1000u,
            live_candidate, output, sizeof output, &written);
    if (status || !live_candidate || live_candidate->copied_source
            || !live_candidate->direct_frame
            || live_candidate->output_work != 4u
            || live_candidate->output_span != 1u
            || live_candidate->output_bytes
               != sizeof cyclic_copy_projected
            || written != sizeof cyclic_copy_projected
            || memcmp(output, cyclic_copy_projected,
                      sizeof cyclic_copy_projected)) {
        fprintf(stderr,
                "native x86 selection: RED (interior live projection "
                "status=%d found=%u candidates=%u source/direct=%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, live_candidate != NULL, live_candidates.count,
                live_candidate
                    ? (unsigned)live_candidate->copied_source : 0u,
                live_candidate
                    ? (unsigned)live_candidate->direct_frame : 0u,
                live_candidate ? live_candidate->output_work : 0u,
                live_candidate ? live_candidate->output_span : 0u,
                live_candidate ? live_candidate->output_bytes : 0u,
                written);
        return 111;
    }
    status = select(
        nested_shift_source, sizeof nested_shift_source, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame || !selected.direct_nested_frame
            || selected.output_work != 5u || selected.output_span != 4u
            || selected.output_bytes != sizeof nested_shift_result
            || written != sizeof nested_shift_result
            || memcmp(output, nested_shift_result,
                      sizeof nested_shift_result)) {
        fprintf(stderr,
                "native x86 selection: RED (nested SSA status=%d "
                "supported/source/alu/nested=%u/%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 180;
    }
    projected = (pl_x86_block){ 0 };
    status = select_projected(
        transient_right_tree_source, sizeof transient_right_tree_source,
        (1u << PL_X86_LOCAL_COUNT) - 1u,
        &selected, output, &written, &projected);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame || !selected.direct_nested_frame
            || selected.output_work != 6u || selected.output_span != 3u
            || selected.output_bytes != sizeof transient_right_tree_result
            || written != sizeof transient_right_tree_result
            || memcmp(output, transient_right_tree_result,
                      sizeof transient_right_tree_result)) {
        fprintf(stderr,
                "native x86 selection: RED (transient right tree status=%d "
                "supported/source/alu/nested=%u/%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        print_block_shape(&projected);
        return 181;
    }
    projected = (pl_x86_block){ 0 };
    status = select_projected(
        conditional_or_source, sizeof conditional_or_source,
        (1u << PL_X86_GPR_COUNT) - 1u,
        &selected, output, &written, &projected);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame || !selected.direct_nested_frame
            || selected.output_work != 8u || selected.output_span != 4u
            || selected.output_bytes != sizeof conditional_or_result
            || written != sizeof conditional_or_result
            || memcmp(output, conditional_or_result,
                      sizeof conditional_or_result)) {
        fprintf(stderr,
                "native x86 selection: RED (conditional OR fold status=%d "
                "supported/source/alu/nested=%u/%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        print_block_shape(&projected);
        return 182;
    }
    status = select(
        constant_widths, sizeof constant_widths, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame
            || selected.source_bytes != 23u
            || selected.output_bytes != 23u
            || selected.output_instructions != 3u
            || selected.output_work != 3u || selected.output_span != 1u
            || written != 23u
            || output[0] != 0x41u || output[1] != 0xb8u
            || output[6] != 0x49u || output[7] != 0xc7u
            || output[8] != 0xc1u
            || output[13] != 0x49u || output[14] != 0xbau
            || output[22] != 0x11u) {
        fprintf(stderr,
                "native x86 selection: RED (constant widths status=%d "
                "supported=%u copied/frame=%u/%u source/output/work=%u/%u/%u "
                "written=%u)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame, selected.source_bytes,
                selected.output_bytes, selected.output_instructions, written);
        return 11;
    }
    status = select(
        noncontiguous_copy, sizeof noncontiguous_copy, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame
            || selected.source_bytes != 12u
            || selected.output_bytes != 9u
            || selected.output_instructions != 3u
            || selected.output_work != 3u || selected.output_span != 1u
            || selected.eliminated_bytes != 3u || written != 9u
            || output[0] != 0x4cu || output[1] != 0x89u
            || output[2] != 0xc1u
            || output[3] != 0x48u || output[4] != 0x89u
            || output[5] != 0xc3u
            || output[6] != 0x48u || output[7] != 0x89u
            || output[8] != 0xfeu) {
        fprintf(stderr,
                "native x86 selection: RED (noncontiguous copy status=%d "
                "supported=%u copied/frame=%u/%u source/output/work=%u/%u/%u "
                "written=%u)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame, selected.source_bytes,
                selected.output_bytes, selected.output_instructions, written);
        return 12;
    }
    status = select(
        dependent_copy, sizeof dependent_copy, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame
            || selected.source_bytes != 12u
            || selected.output_bytes != 9u
            || selected.output_instructions != 3u
            || selected.output_work != 3u || selected.output_span != 1u
            || selected.eliminated_bytes != 3u || written != 9u
            || output[0] != 0x48u || output[1] != 0x89u
            || output[2] != 0xf9u
            || output[3] != 0x48u || output[4] != 0x89u
            || output[5] != 0xc2u
            || output[6] != 0x48u || output[7] != 0x89u
            || output[8] != 0xd8u) {
        fprintf(stderr,
                "native x86 selection: RED (dependent copy status=%d "
                "supported=%u copied/frame=%u/%u source/output/work=%u/%u/%u "
                "written=%u)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame, selected.source_bytes,
                selected.output_bytes, selected.output_instructions, written);
        return 13;
    }
    status = select(
        invalid_fault, sizeof invalid_fault, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || !selected.copied_source
            || selected.direct_frame || selected.source_bytes != 1u
            || selected.output_bytes != 1u
            || selected.output_instructions != 1u
            || selected.output_work != 1u || selected.output_span != 1u
            || written != 1u
            || output[0] != invalid_fault[0]) {
        fprintf(stderr,
                "native x86 selection: RED (precise invalid fault status=%d "
                "supported=%u copied/frame=%u/%u source/output/work=%u/%u/%u "
                "written=%u byte=%02x)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame, selected.source_bytes,
                selected.output_bytes, selected.output_instructions, written,
                (unsigned)output[0]);
        return 14;
    }
    status = select(
        affine_overwrite, sizeof affine_overwrite, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame || !selected.direct_add_frame
            || selected.source_bytes != 8u || selected.output_bytes != 4u
            || selected.output_instructions != 1u || written != 4u
            || output[0] != 0x48u || output[1] != 0x8du
            || output[2] != 0x47u || output[3] != 0x02u) {
        fprintf(stderr,
                "native x86 selection: RED (affine overwrite status=%d "
                "supported=%u source/frame/add=%u/%u/%u "
                "source/output/work=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame,
                (unsigned)selected.direct_add_frame,
                selected.source_bytes, selected.output_bytes,
                selected.output_instructions, written);
        return 15;
    }
    status = select(
        affine_and_copy, sizeof affine_and_copy, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame || !selected.direct_add_frame
            || selected.source_bytes != 7u || selected.output_bytes != 7u
            || selected.output_instructions != 2u
            || selected.output_work != 2u || selected.output_span != 1u
            || written != 7u
            || output[0] != 0x48u || output[1] != 0x8du
            || output[2] != 0x75u || output[3] != 0xa0u
            || output[4] != 0x48u || output[5] != 0x89u
            || output[6] != 0xdfu) {
        fprintf(stderr,
                "native x86 selection: RED (affine+copy status=%d "
                "supported=%u source/frame/add=%u/%u/%u "
                "source/output/work=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame,
                (unsigned)selected.direct_add_frame,
                selected.source_bytes, selected.output_bytes,
                selected.output_instructions, written);
        return 16;
    }
    status = select(
        alu_and_old_value_copy, sizeof alu_and_old_value_copy, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame || !selected.direct_alu_frame
            || selected.source_bytes != 7u || selected.output_bytes != 7u
            || selected.output_instructions != 2u
            || selected.output_work != 2u || selected.output_span != 1u
            || written != 7u
            || output[0] != 0x48u || output[1] != 0x89u
            || output[2] != 0xe2u
            || output[3] != 0x48u || output[4] != 0x83u
            || output[5] != 0xe4u || output[6] != 0xf0u) {
        fprintf(stderr,
                "native x86 selection: RED (ALU+old-value copy status=%d "
                "supported=%u source/frame/alu=%u/%u/%u "
                "source/output/work/span=%u/%u/%u/%u written=%u)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame,
                (unsigned)selected.direct_alu_frame,
                selected.source_bytes, selected.output_bytes,
                selected.output_instructions, selected.output_span, written);
        return 21;
    }
    status = select(
        parallel_alu_and_address, sizeof parallel_alu_and_address, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame || !selected.direct_alu_frame
            || selected.fixup_count != 1u
            || selected.fixups[0].kind
               != PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT
            || selected.fixups[0].at != 5u
            || selected.fixups[0].next_ip_at != 9u
            || selected.fixups[0].source_at != 8u
            || selected.fixups[0].source_bytes != 4u
            || selected.fixups[0].target != 0x100cu
            || selected.source_bytes != 12u || selected.output_bytes != 12u
            || selected.output_instructions != 3u
            || selected.output_work != 3u || selected.output_span != 1u
            || written != 12u
            || output[0] != 0x31u || output[1] != 0xc9u
            || output[2] != 0x48u || output[3] != 0x8du
            || output[4] != 0x3du || output[5] || output[6]
            || output[7] || output[8]
            || output[9] != 0x41u || output[10] != 0x89u
            || output[11] != 0xc8u) {
        fprintf(stderr,
                "native x86 selection: RED (parallel ALU+address status=%d "
                "supported=%u source/frame/alu=%u/%u/%u fixup=%u "
                "source/output/work/span=%u/%u/%u/%u written=%u "
                "bytes=%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x)\n",
                status, (unsigned)selected.supported,
                (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame,
                (unsigned)selected.direct_alu_frame,
                selected.fixup_count, selected.source_bytes,
                selected.output_bytes, selected.output_instructions,
                selected.output_span, written,
                output[0], output[1], output[2], output[3], output[4],
                output[5], output[6], output[7], output[8], output[9],
                output[10], output[11]);
        return 22;
    }
    status = candidates(
        parallel_alu_and_address, sizeof parallel_alu_and_address, 0x1000u,
        &alternatives);
    pl_u32 source_span = 0u;
    pl_u32 source_work = 0u;
    for (pl_u32 index = 0u; !status && index < alternatives.count;
            ++index)
        if (alternatives.candidate[index].copied_source) {
            source_span = alternatives.candidate[index].output_span;
            source_work = alternatives.candidate[index].output_work;
        }
    if (status || source_span != 1u || source_work != 3u) {
        fprintf(stderr,
                "native x86 selection: RED (source dependency certificate "
                "status=%d work/span=%u/%u)\n",
                status, source_work, source_span);
        return 23;
    }
    projected = (pl_x86_block){ 0 };
    status = select_projected(
        cios_carry_slice, sizeof cios_carry_slice,
        (1u << PL_X86_LOCAL_COUNT) - 1u,
        &selected, output, &written, &projected);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !selected.direct_condition_carry_frame
            || selected.output_work != 3u || selected.output_span != 2u
            || selected.output_bytes != sizeof cios_carry_slice
            || written != sizeof cios_carry_slice
            || projected.plan.node_count != 4u
            || memcmp(output, cios_carry_slice, sizeof cios_carry_slice)) {
        fprintf(stderr,
                "native x86 selection: RED (CIOS SETcc/ADD/ADC "
                "status=%d source/normalized/direct=%u/%u/%u "
                "work/span/bytes=%u/%u/%u plan=%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_condition_carry_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, projected.plan.node_count, written);
        print_block_shape(&projected);
        return 51;
    }
    projected = (pl_x86_block){ 0 };
    status = select_projected(
        masked_sign_test_branch, sizeof masked_sign_test_branch,
        (1u << PL_X86_LOCAL_COUNT) - 1u,
        &selected, output, &written, &projected);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_value_predicate_frame
            || selected.output_work != 3u || selected.output_span != 2u
            || written != sizeof masked_sign_test_branch_result
            || memcmp(output, masked_sign_test_branch_result,
                      sizeof masked_sign_test_branch_result)) {
        fprintf(stderr,
                "native x86 selection: RED (masked sign-extend predicate "
                "status=%d source/direct=%u/%u work/span/bytes=%u/%u/%u "
                "plan=%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, projected.plan.node_count,
                projected.plan.span, written);
        pl_x86_native_candidates diagnostic = { 0 };
        int candidate_status = candidates(
            masked_sign_test_branch, sizeof masked_sign_test_branch,
            0x1000u, &diagnostic);
        fprintf(stderr, "  candidates status/count=%d/%u\n",
                candidate_status, diagnostic.count);
        for (pl_u32 index = 0u; index < diagnostic.count; ++index) {
            const pl_x86_native_selection *candidate =
                &diagnostic.candidate[index];
            fprintf(stderr,
                    "  candidate[%u] source/direct/normalized=%u/%u/%u "
                    "instructions/work/span/bytes=%u/%u/%u/%u\n",
                    index, (unsigned)candidate->copied_source,
                    (unsigned)candidate->direct_frame,
                    (unsigned)candidate->normalized_family_present,
                    candidate->output_instructions,
                    candidate->output_work, candidate->output_span,
                    candidate->output_bytes);
        }
        print_block_shape(&projected);
        return 52;
    }
    projected = (pl_x86_block){ 0 };
    status = select_projected(
        compare_handoff_branch, sizeof compare_handoff_branch,
        (1u << PL_X86_LOCAL_COUNT) - 1u,
        &selected, output, &written, &projected);
    if (status || !selected.supported || selected.copied_source
            || !(selected.direct_compare_handoff_frame || selected.direct_alu_frame)
            || selected.output_work != 5u || selected.output_span != 3u) {
        fprintf(stderr,
                "native x86 selection: RED (compare owner handoff "
                "status=%d source/direct/handoff=%u/%u/%u "
                "work/span/bytes=%u/%u/%u plan=%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame,
                (unsigned)selected.direct_compare_handoff_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, projected.plan.node_count,
                projected.plan.span, written);
        print_block_shape(&projected);
        return 53;
    }
    status = select(
        aligned_subtract_handoff_branch,
        sizeof aligned_subtract_handoff_branch, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame
            || selected.output_work != 11u || selected.output_span != 5u
            || selected.output_bytes
               != sizeof aligned_subtract_handoff_result
            || written != sizeof aligned_subtract_handoff_result
            || memcmp(output, aligned_subtract_handoff_result,
                      sizeof aligned_subtract_handoff_result)) {
        fprintf(stderr,
                "native x86 selection: RED (aligned subtract handoff "
                "status=%d source/direct=%u/%u work/span/bytes=%u/%u/%u "
                "written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 54;
    }
    status = select(
        parallel_variable_shift_branch,
        sizeof parallel_variable_shift_branch, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame || !(selected.direct_branch_frame || selected.direct_alu_frame)
            || selected.output_work != 9u || selected.output_span != 4u
            || selected.output_bytes
               != sizeof parallel_variable_shift_result
            || written != sizeof parallel_variable_shift_result
            || memcmp(output, parallel_variable_shift_result,
                      sizeof parallel_variable_shift_result)) {
        fprintf(stderr,
                "native x86 selection: RED (parallel variable shifts "
                "status=%d source/direct/branch=%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame,
                (unsigned)selected.direct_branch_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        for (pl_u32 i = 0u; i < written; ++i) fprintf(stderr, " %02x", output[i]);
        fputc('\n', stderr);
        return 55;
    }
    status = select(
        arx_shared_dag_source, sizeof arx_shared_dag_source, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame || !selected.direct_arx_frame
            || selected.output_work != 18u || selected.output_span != 5u
            || selected.output_bytes != sizeof arx_shared_dag_result
            || written != sizeof arx_shared_dag_result
            || memcmp(output, arx_shared_dag_result,
                      sizeof arx_shared_dag_result)) {
        fprintf(stderr,
                "native x86 selection: RED (ARX shared DAG "
                "status=%d source/direct/arx=%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame,
                (unsigned)selected.direct_arx_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 193;
    }
    status = select(
        arx_shared_dag_source + 1u,
        sizeof arx_shared_dag_source - 1u, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_arx_frame
            || selected.output_work != 18u || selected.output_span != 5u
            || selected.output_bytes != sizeof arx_shared_dag_low32_result
            || written != sizeof arx_shared_dag_low32_result
            || memcmp(output, arx_shared_dag_low32_result,
                      sizeof arx_shared_dag_low32_result)) {
        fprintf(stderr,
                "native x86 selection: RED (ARX low32 seed "
                "status=%d source/arx=%u/%u work/span/bytes=%u/%u/%u "
                "written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_arx_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 194;
    }
    status = select(
        arx_shared_dag_source + 15u,
        sizeof arx_shared_dag_source - 15u, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_mutable_xor_frame
            || selected.output_work != 14u || selected.output_span != 4u
            || selected.output_bytes != sizeof mutable_xor_result
            || written != sizeof mutable_xor_result
            || memcmp(output, mutable_xor_result,
                      sizeof mutable_xor_result)) {
        fprintf(stderr,
                "native x86 selection: RED (mutable XOR leaf "
                "status=%d source/mutable=%u/%u work/span/bytes=%u/%u/%u "
                "written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_mutable_xor_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 195;
    }
    status = select(
        recursive_affine_source, sizeof recursive_affine_source,
        0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_alu_frame
            || selected.output_work != 4u || selected.output_span != 2u
            || selected.output_bytes != sizeof recursive_affine_result
            || written != sizeof recursive_affine_result
            || memcmp(output, recursive_affine_result,
                      sizeof recursive_affine_result)) {
        fprintf(stderr,
                "native x86 selection: RED (recursive affine LEA "
                "status=%d source/alu=%u/%u work/span/bytes=%u/%u/%u "
                "written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 196;
    }
    status = select(
        overwritten_carry_source, sizeof overwritten_carry_source,
        0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_live_frame
            || selected.output_work != 4u || selected.output_span != 2u
            || selected.output_bytes != sizeof overwritten_carry_result
            || written != sizeof overwritten_carry_result
            || memcmp(output, overwritten_carry_result,
                      sizeof overwritten_carry_result)) {
        fprintf(stderr,
                "native x86 selection: RED (overwritten carry lane "
                "status=%d source/live=%u/%u work/span/bytes=%u/%u/%u "
                "written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_live_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 197;
    }
    status = select(
        affine_fanout_source, sizeof affine_fanout_source,
        0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_affine_frame
            || selected.output_work != 3u || selected.output_span != 2u
            || selected.output_bytes != sizeof affine_fanout_result
            || written != sizeof affine_fanout_result
            || memcmp(output, affine_fanout_result,
                      sizeof affine_fanout_result)) {
        fprintf(stderr,
                "native x86 selection: RED (affine fanout substitution "
                "status=%d source/affine=%u/%u work/span/bytes=%u/%u/%u "
                "written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_affine_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 198;
    }
    status = select(
        signed_affine_fanout_source, sizeof signed_affine_fanout_source,
        0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_affine_frame
            || selected.output_work != 4u || selected.output_span != 2u
            || selected.output_bytes != sizeof signed_affine_fanout_result
            || written != sizeof signed_affine_fanout_result
            || memcmp(output, signed_affine_fanout_result,
                      sizeof signed_affine_fanout_result)) {
        fprintf(stderr,
                "native x86 selection: RED (signed affine fanout "
                "status=%d source/affine=%u/%u work/span/bytes=%u/%u/%u "
                "written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_affine_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 199;
    }
    status = select(
        immediate_compare_branch_source,
        sizeof immediate_compare_branch_source, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !(selected.direct_branch_frame || selected.direct_alu_frame)
            || selected.output_work != 3u || selected.output_span != 2u
            || selected.output_bytes
               != sizeof immediate_compare_branch_result
            || written != sizeof immediate_compare_branch_result
            || memcmp(output, immediate_compare_branch_result,
                      sizeof immediate_compare_branch_result)) {
        fprintf(stderr,
                "native x86 selection: RED (immediate compare branch "
                "status=%d source/normalized/direct=%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_branch_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 200;
    }
    status = select(
        entry_flag_branch_source, sizeof entry_flag_branch_source,
        0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !(selected.direct_entry_branch_frame || selected.direct_alu_frame)
            || selected.output_work != 3u || selected.output_span != 2u
            || selected.output_bytes != sizeof entry_flag_branch_result
            || written != sizeof entry_flag_branch_result
            || memcmp(output, entry_flag_branch_result,
                      sizeof entry_flag_branch_result)) {
        fprintf(stderr,
                "native x86 selection: RED (entry-flag branch "
                "status=%d source/normalized/direct=%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_entry_branch_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 201;
    }
    status = select(
        zero_extend_generation_source,
        sizeof zero_extend_generation_source, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !selected.direct_alu_frame || !selected.direct_nested_frame
            || selected.output_work != 4u || selected.output_span != 2u
            || selected.output_bytes
               != sizeof zero_extend_generation_result
            || written != sizeof zero_extend_generation_result
            || memcmp(output, zero_extend_generation_result,
                      sizeof zero_extend_generation_result)) {
        fprintf(stderr,
                "native x86 selection: RED (zero-extend generation "
                "status=%d source/normalized/alu/nested=%u/%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 202;
    }
    status = select(
        byte_test_select_source, sizeof byte_test_select_source,
        0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !selected.direct_alu_frame
            || selected.output_work != 6u || selected.output_span != 2u
            || selected.output_bytes != sizeof byte_test_select_result
            || written != sizeof byte_test_select_result
            || memcmp(output, byte_test_select_result,
                      sizeof byte_test_select_result)) {
        fprintf(stderr,
                "native x86 selection: RED (byte-test select "
                "status=%d source/normalized/alu=%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 203;
    }
    status = select(
        zero_flag_entry_copy_source,
        sizeof zero_flag_entry_copy_source, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !selected.direct_alu_frame
            || selected.output_work != 5u || selected.output_span != 2u
            || selected.output_bytes
               != sizeof zero_flag_entry_copy_result
            || written != sizeof zero_flag_entry_copy_result
            || memcmp(output, zero_flag_entry_copy_result,
                      sizeof zero_flag_entry_copy_result)) {
        fprintf(stderr,
                "native x86 selection: RED (zero flag entry copies "
                "status=%d source/normalized/zero=%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_zero_flag_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 204;
    }
    status = select(
        zero_flag_address_copy_source,
        sizeof zero_flag_address_copy_source, 0x1000u,
        &selected, output, &written);
    int has_wide_address_copy = 0;
    for (pl_u32 at = 0u; at + 2u < written; ++at)
        if (output[at] == 0x48u && output[at + 1u] == 0x89u
                && output[at + 2u] == 0xcau)
            has_wide_address_copy = 1;
    if (status || !selected.supported || !has_wide_address_copy) {
        fprintf(stderr,
                "native x86 selection: RED (PIE address copy width "
                "status=%d bytes=%u)\n", status, written);
        return 205;
    }
    pl_x86_map address_select_map = {
        address_select_source, 0x439767u,
        sizeof address_select_source, sizeof address_select_source,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image address_select_image = {
        &address_select_map, 1u, 0u, 0x439767u,
    };
    status = select_image_projected(
        &address_select_image, sizeof address_select_source,
        (1u << 0u) | (1u << 2u), 0,
        &selected, output, &written, 0);
    int has_wide_address_select = 0;
    for (pl_u32 at = 0u; at + 3u < written; ++at)
        if (output[at] == 0x48u && output[at + 1u] == 0x0fu
                && output[at + 2u] == 0x45u
                && output[at + 3u] == 0xc2u)
            has_wide_address_select = 1;
    if (status || !selected.supported || !has_wide_address_select) {
        fprintf(stderr,
                "native x86 selection: RED (PIE address select width "
                "status=%d bytes=%u)\n", status, written);
        return 206;
    }
    pl_x86_map published_address_map = {
        published_address_add_source, 0x4dbb6u,
        sizeof published_address_add_source,
        sizeof published_address_add_source,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image published_address_image = {
        &published_address_map, 1u, 0u, 0x4dbb6u,
    };
    status = select_image_projected(
        &published_address_image, sizeof published_address_add_source,
        0x7ffffu, 0, &selected, output, &written, 0);
    pl_u32 address_at = written, add_at = written;
    for (pl_u32 at = 0u; at < written; ++at) {
        if (at + 6u < written && output[at] == 0x48u
                && output[at + 1u] == 0x8du
                && output[at + 2u] == 0x05u)
            address_at = at;
        if (at + 2u < written && output[at] == 0x48u
                && output[at + 1u] == 0x01u
                && output[at + 2u] == 0xc3u)
            add_at = at;
    }
    if (status || !selected.supported
            || (add_at < written && address_at >= add_at)) {
        fprintf(stderr,
                "native x86 selection: RED (published PIE address order "
                "status=%d address/add=%u/%u bytes=%u)\n",
                status, address_at, add_at, written);
        return 207;
    }
    pl_x86_map derived_address_map = {
        derived_address_source, 0x6d0efu,
        sizeof derived_address_source,
        sizeof derived_address_source,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image derived_address_image = {
        &derived_address_map, 1u, 0u, 0x6d0efu,
    };
    status = select_image_projected(
        &derived_address_image, sizeof derived_address_source,
        0x7ffffu, 0, &selected, output, &written, 0);
    if (status || !selected.supported || !selected.copied_source
            || written != sizeof derived_address_source) {
        fprintf(stderr,
                "native x86 selection: RED (derived PIE address "
                "status=%d source=%u bytes=%u)\n",
                status, (unsigned)selected.copied_source, written);
        return 208;
    }
    pl_x86_map entry_shift_map = {
        entry_shift_count_source, 0x1639efu,
        sizeof entry_shift_count_source,
        sizeof entry_shift_count_source,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image entry_shift_image = {
        &entry_shift_map, 1u, 0u, 0x1639efu,
    };
    pl_x86_block entry_shift_block;
    status = select_image_projected(
        &entry_shift_image, sizeof entry_shift_count_source,
        0x73cf5u, 0, &selected, output, &written, &entry_shift_block);
    pl_u32 old_count_shift = written, new_count_move = written;
    for (pl_u32 at = 0u; at < written; ++at) {
        if (at + 1u < written && output[at] == 0xd3u
                && output[at + 1u] == 0xe2u)
            old_count_shift = at;
        if (at + 2u < written && output[at] == 0x44u
                && output[at + 1u] == 0x89u
                && output[at + 2u] == 0xc1u)
            new_count_move = at;
    }
    if (status || !selected.supported || old_count_shift >= written
            || new_count_move >= written
            || old_count_shift >= new_count_move) {
        pl_x86_alu_schedule_diagnostic diagnostic;
        int diagnostic_status = status ? status
            : pl_x86_select_alu_schedule_diagnostic(
                &entry_shift_block, &diagnostic);
        fprintf(stderr,
                "native x86 selection: RED (entry shift count lifetime "
                "status=%d old-shift/new-move=%u/%u bytes=%u "
                "laws=%d EDX-source=0x%x ECX-source=0x%x)\n",
                status, old_count_shift, new_count_move, written,
                diagnostic_status,
                diagnostic_status ? 0u : diagnostic.sources[2u],
                diagnostic_status ? 0u : diagnostic.sources[1u]);
        return 209;
    }
    status = select(
        shift_count_same_register_source,
        sizeof shift_count_same_register_source,
        0x1000u, &selected, output, &written);
    for (pl_u32 at = 0u; !status && at + 7u < written; ++at) {
        if (output[at] == 0xb9u && output[at + 1u] == 0x01u
                && output[at + 2u] == 0x00u
                && output[at + 3u] == 0x00u
                && output[at + 4u] == 0x00u
                && output[at + 5u] == 0x48u
                && output[at + 6u] == 0xd3u
                && output[at + 7u] == 0xe1u) {
            fprintf(stderr,
                    "native x86 selection: RED (entry CL overwritten "
                    "before variable shift, direct=%u live=%u "
                    "nested=%u shared=%u bytes=%u)\n",
                    (unsigned)selected.direct_frame,
                    (unsigned)selected.direct_live_frame,
                    (unsigned)selected.direct_nested_frame,
                    (unsigned)selected.direct_shared_dag_frame,
                    written);
            for (pl_u32 byte = 0u; byte < written; ++byte)
                fprintf(stderr, "%02x%s", output[byte],
                        byte + 1u == written ? "\n" : " ");
            return 210;
        }
    }
    if (status || !selected.supported) {
        fprintf(stderr,
                "native x86 selection: RED (entry CL fixture status=%d)\n",
                status);
        return 210;
    }
    status = select(
        wide_indexed_address_source, sizeof wide_indexed_address_source,
        0x1000u, &selected, output, &written);
    for (pl_u32 at = 0u; !status && at + 3u < written; ++at)
        if (output[at] == 0x8du && output[at + 1u] == 0x7cu
                && output[at + 2u] == 0x0du
                && output[at + 3u] == 0x04u) {
            fprintf(stderr,
                    "native x86 selection: RED (wide pointer truncated "
                    "by LEA EDI)\n");
            return 211;
        }
    if (status || !selected.supported) {
        fprintf(stderr,
                "native x86 selection: RED (wide indexed address "
                "status=%d)\n", status);
        return 211;
    }
    status = select(
        published_zero_extend_source,
        sizeof published_zero_extend_source, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !selected.direct_alu_frame || !selected.direct_nested_frame
            || selected.output_work != 5u || selected.output_span != 2u
            || selected.output_bytes
               != sizeof published_zero_extend_result
            || written != sizeof published_zero_extend_result
            || memcmp(output, published_zero_extend_result,
                      sizeof published_zero_extend_result)) {
        fprintf(stderr,
                "native x86 selection: RED (published zero extend "
                "status=%d source/normalized/alu/nested=%u/%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 205;
    }
    status = select(
        shared_shift_mask_source, sizeof shared_shift_mask_source,
        0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !selected.direct_alu_frame
            || !selected.direct_shared_parent_frame
            || selected.output_work != 10u || selected.output_span != 6u
            || selected.output_bytes != sizeof shared_shift_mask_result
            || written != sizeof shared_shift_mask_result
            || memcmp(output, shared_shift_mask_result,
                      sizeof shared_shift_mask_result)) {
        fprintf(stderr,
                "native x86 selection: RED (shared shifted parent "
                "status=%d source/normalized/alu/parent=%u/%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_shared_parent_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 206;
    }
    status = select(
        shifted_copy_overlay_source, sizeof shifted_copy_overlay_source,
        0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !selected.direct_alu_frame || !selected.direct_nested_frame
            || selected.output_work != 14u || selected.output_span != 5u
            || selected.output_bytes != sizeof shifted_copy_overlay_result
            || written != sizeof shifted_copy_overlay_result
            || memcmp(output, shifted_copy_overlay_result,
                      sizeof shifted_copy_overlay_result)) {
        fprintf(stderr,
                "native x86 selection: RED (shifted copy overlay "
                "status=%d source/normalized/alu/nested=%u/%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 207;
    }
    status = select(
        entry_select_overlay_source, sizeof entry_select_overlay_source,
        0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !selected.direct_alu_frame || !selected.direct_nested_frame
            || selected.output_work != 12u || selected.output_span != 5u
            || selected.output_bytes != sizeof entry_select_overlay_result
            || written != sizeof entry_select_overlay_result
            || memcmp(output, entry_select_overlay_result,
                      sizeof entry_select_overlay_result)) {
        fprintf(stderr,
                "native x86 selection: RED (entry select overlay "
                "status=%d source/normalized/alu/nested=%u/%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 208;
    }
    status = select(
        parallel_entry_overlay_source, sizeof parallel_entry_overlay_source,
        0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !selected.direct_alu_frame || !selected.direct_nested_frame
            || selected.output_work != 11u || selected.output_span != 4u
            || selected.output_bytes != sizeof parallel_entry_overlay_result
            || written != sizeof parallel_entry_overlay_result
            || memcmp(output, parallel_entry_overlay_result,
                      sizeof parallel_entry_overlay_result)) {
        fprintf(stderr,
                "native x86 selection: RED (parallel entry overlay "
                "status=%d source/normalized/alu/nested=%u/%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 209;
    }
    status = select(
        split_entry_overlay_source, sizeof split_entry_overlay_source,
        0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !selected.direct_alu_frame || !selected.direct_nested_frame
            || selected.output_work != 8u || selected.output_span != 3u
            || selected.output_bytes != sizeof split_entry_overlay_result
            || written != sizeof split_entry_overlay_result
            || memcmp(output, split_entry_overlay_result,
                      sizeof split_entry_overlay_result)) {
        fprintf(stderr,
                "native x86 selection: RED (split entry overlay "
                "status=%d source/normalized/alu/nested=%u/%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 210;
    }
    status = select(
        low32_entry_overlay_source, sizeof low32_entry_overlay_source,
        0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !selected.direct_alu_frame || !selected.direct_nested_frame
            || selected.output_work != 8u || selected.output_span != 3u
            || selected.output_bytes != sizeof low32_entry_overlay_result
            || written != sizeof low32_entry_overlay_result
            || memcmp(output, low32_entry_overlay_result,
                      sizeof low32_entry_overlay_result)) {
        fprintf(stderr,
                "native x86 selection: RED (low32 entry overlay "
                "status=%d source/normalized/alu/nested=%u/%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 211;
    }
    status = select(
        narrow_flag_transfer_source, sizeof narrow_flag_transfer_source,
        0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !selected.direct_alu_frame || !selected.direct_nested_frame
            || selected.output_work != 3u || selected.output_span != 2u
            || selected.output_bytes != sizeof narrow_flag_transfer_result
            || written != sizeof narrow_flag_transfer_result
            || memcmp(output, narrow_flag_transfer_result,
                      sizeof narrow_flag_transfer_result)) {
        fprintf(stderr,
                "native x86 selection: RED (narrow flag transfer "
                "status=%d source/normalized/alu/nested=%u/%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 212;
    }
    status = select(
        entry_select_bit_test, sizeof entry_select_bit_test,
        0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !selected.direct_alu_frame || !selected.direct_nested_frame
            || selected.output_work != 4u || selected.output_span != 2u
            || selected.output_bytes != sizeof entry_select_bit_test
            || written != sizeof entry_select_bit_test
            || memcmp(output, entry_select_bit_test,
                      sizeof entry_select_bit_test)) {
        fprintf(stderr,
                "native x86 selection: RED (entry select bit test "
                "status=%d source/normalized/alu/nested=%u/%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 213;
    }
    status = select(
        destination_reuse_source, sizeof destination_reuse_source,
        0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !selected.direct_alu_frame || !selected.direct_nested_frame
            || selected.output_work != 13u || selected.output_span != 7u
            || selected.output_bytes != sizeof destination_reuse_result
            || written != sizeof destination_reuse_result
            || memcmp(output, destination_reuse_result,
                      sizeof destination_reuse_result)) {
        fprintf(stderr,
                "native x86 selection: RED (destination reuse "
                "status=%d source/normalized/alu/nested=%u/%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 214;
    }
    status = select(
        balanced_reduction_source, sizeof balanced_reduction_source,
        0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !selected.direct_alu_frame || !selected.direct_nested_frame
            || selected.output_work != 15u || selected.output_span != 4u
            || selected.output_bytes != sizeof balanced_reduction_result
            || written != sizeof balanced_reduction_result
            || memcmp(output, balanced_reduction_result,
                      sizeof balanced_reduction_result)) {
        fprintf(stderr,
                "native x86 selection: RED (balanced reduction "
                "status=%d source/normalized/alu/nested=%u/%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 215;
    }
    status = select(
        masked_entry_affine_source, sizeof masked_entry_affine_source,
        0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !selected.direct_alu_frame || !selected.direct_nested_frame
            || selected.output_work != 9u || selected.output_span != 2u
            || selected.output_bytes != sizeof masked_entry_affine_result
            || written != sizeof masked_entry_affine_result
            || memcmp(output, masked_entry_affine_result,
                      sizeof masked_entry_affine_result)) {
        fprintf(stderr,
                "native x86 selection: RED (masked entry affine "
                "status=%d source/normalized/alu/nested=%u/%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 216;
    }
    status = select_projected(
        conditional_address_handoff_source, sizeof conditional_address_handoff_source,
        (1u << PL_X86_LOCAL_COUNT) - 1u,
        &selected, output, &written, &projected);
    if (status || !selected.supported || !selected.normalized_family_present
            || selected.output_work > 3u || selected.output_span > 2u) {
        fprintf(stderr,
                "native x86 selection: RED (conditional address handoff "
                "status=%d source/normalized=%u/%u work/span/bytes=%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                selected.output_work, selected.output_span,
                selected.output_bytes);
        print_block_shape(&projected);
        pl_x86_native_candidates failed = { 0 };
        int failure_status = candidates_projected(
            conditional_address_handoff_source, sizeof conditional_address_handoff_source,
            (1u << PL_X86_LOCAL_COUNT) - 1u, &failed);
        fprintf(stderr, "conditional candidates: status=%d count=%u stage=%u blocking=%x\n",
                failure_status, failed.count, failed.diagnostic_stage,
                failed.diagnostic.blocking_work);
        return 219;
    }
    /* The low linked coordinate is rebased above 4 GiB by a PIE loader.
     * Sharing this address must not narrow its alias to MOV EDI,EDX. */
    static const pl_u8 address_copy_source[] = {
        0x48u, 0x8du, 0x15u, 0u, 1u, 0u, 0u, 0x48u, 0x89u, 0xd7u,
    };
    status = select_projected(
        address_copy_source, sizeof address_copy_source,
        (1u << PL_X86_LOCAL_COUNT) - 1u,
        &selected, output, &written, &projected);
    for (pl_u32 i = 0u; !status && i < selected.fixup_count; ++i)
        status = pl_x86_select_bind_fixup(
            output, written, &selected, i, 0x1000u, selected.fixups[i].target);
    if (status || !selected.normalized_family_present
            || written != sizeof address_copy_source
            || memcmp(output, address_copy_source, sizeof address_copy_source)) {
        fprintf(stderr, "native x86 selection: RED (rebased pointer copy)\n");
        return 223;
    }
    /* A byte predicate is still a register comparison, not a materialized
     * low-byte extraction. Keep the unrelated entry copy in the same cut. */
    static const pl_u8 byte_compare_copy_source[] = {
        0x48u, 0x89u, 0xd7u, 0x41u, 0x80u, 0xfau, 0x04u,
        0x0fu, 0x87u, 0xaeu, 0xffu, 0xffu, 0xffu,
    };
    status = select_projected(
        byte_compare_copy_source, sizeof byte_compare_copy_source,
        (1u << PL_X86_LOCAL_COUNT) - 1u,
        &selected, output, &written, &projected);
    if (status || !selected.supported || !selected.normalized_family_present
            || selected.output_work > 3u || selected.output_span > 2u) {
        fprintf(stderr, "native x86 selection: RED (byte compare copy "
                "status=%d work/span=%u/%u)\n",
                status, selected.output_work, selected.output_span);
        print_block_shape(&projected);
        return 222;
    }
    status = select_projected(
        signed_digit_accumulation_source, sizeof signed_digit_accumulation_source,
        (1u << PL_X86_LOCAL_COUNT) - 1u,
        &selected, output, &written, &projected);
    if (status || !selected.supported || !selected.normalized_family_present
            || selected.output_work > 7u) {
        pl_x86_native_candidates failed = { 0 };
        (void)candidates_projected(
            signed_digit_accumulation_source, sizeof signed_digit_accumulation_source,
            (1u << PL_X86_LOCAL_COUNT) - 1u, &failed);
        fprintf(stderr, "native x86 selection: RED (signed digit accumulation "
                "status=%d work/span=%u/%u rejection=%x/%x)\n",
                status, selected.output_work, selected.output_span,
                failed.diagnostic.blocking_work, failed.diagnostic.blocking_opcode);
        print_block_shape(&projected);
        return 220;
    }
    /* Borrow is a dependency of the arithmetic result even when the final
     * flags come from an independent zero publication. */
    static const pl_u8 compare_borrow_source[] = {
        0x48u, 0x8du, 0x3du, 0xf8u, 0xabu, 0x03u, 0u,
        0x49u, 0x89u, 0xc6u, 0x48u, 0x39u, 0xc2u,
        0x49u, 0x83u, 0xdeu, 0u, 0x45u, 0x31u, 0xc0u,
    };
    status = select_projected(
        compare_borrow_source, sizeof compare_borrow_source,
        (1u << PL_X86_LOCAL_COUNT) - 1u,
        &selected, output, &written, &projected);
    if (status || !selected.normalized_family_present || selected.output_work > 5u) {
        pl_x86_native_candidates failed = { 0 };
        (void)candidates_projected(compare_borrow_source, sizeof compare_borrow_source,
            (1u << PL_X86_LOCAL_COUNT) - 1u, &failed);
        fprintf(stderr, "native x86 selection: RED (compare borrow "
                "status=%d work/span=%u/%u rejection=%x/%x)\n",
                status, selected.output_work, selected.output_span,
                failed.diagnostic.blocking_work, failed.diagnostic.blocking_opcode);
        print_block_shape(&projected);
        return 224;
    }
    /* Both cut exits consume the same normalized value grammar: a comparison
     * with an immediate must not lose the shifted/bitwise publication path. */
    static const pl_u8 masked_shift_compare[] = {
        0x48u, 0x89u, 0xf2u, 0x48u, 0x89u, 0xf8u, 0x83u, 0xe2u, 0x42u,
        0x48u, 0xc1u, 0xe0u, 0x0cu, 0x48u, 0x83u, 0xfau, 0x40u, 0x75u, 4u,
    };
    static const pl_u8 address_subtract_flags[] = {
        0x89u, 0xdau, 0x31u, 0xc0u, 0x48u, 0x8du, 0x3du,
        0xdau, 0x95u, 3u, 0u, 0x29u, 0xcau,
    };
    static const pl_u8 word_test_boolean[] = {
        0x45u, 0x31u, 0xedu, 0x4cu, 0x89u, 0xe6u, 0x48u, 0x89u, 0xefu,
        0x85u, 0xc0u, 0x41u, 0x0fu, 0x94u, 0xc5u,
    };
    static const pl_u8 add_carry_branch[] = {
        0x89u, 0xd1u, 0xbau, 0u, 0u, 0u, 0x80u, 0x31u, 0xc0u,
        0x48u, 0x01u, 0xf2u, 0x0fu, 0x92u, 0xc0u, 0x84u, 0xc9u, 0x74u, 0x33u,
    };
    /* Shared conditional address and borrow-derived arithmetic must retain
     * their entry-register generations until both publications are ready. */
    static const pl_u8 conditional_borrow_fanout[] = {
        0x48u, 0x85u, 0xffu, 0x48u, 0x8du, 0x05u, 0xcfu, 0x5au, 3u, 0u,
        0x48u, 0x0fu, 0x45u, 0xc7u, 0x48u, 0x83u, 0xfeu, 3u,
        0x48u, 0x89u, 0xe7u, 0x48u, 0x19u, 0xdbu,
        0x81u, 0xe3u, 1u, 0x36u, 0x65u, 4u, 0x49u, 0x89u, 0xc4u,
        0x48u, 0x81u, 0xebu, 0xfeu, 0x35u, 0x65u, 4u, 0x48u, 0x89u, 0xdeu,
    };
    static const pl_u8 signed_overlay[] = {
        0x41u, 0x83u, 0xe0u, 0x0fu, 0x41u, 0xc1u, 0xe0u, 0x10u,
        0xc1u, 0xe0u, 0x10u, 0x41u, 0x09u, 0xd0u, 0x89u, 0xdau,
        0x09u, 0xf0u, 0x48u, 0x89u, 0xeeu, 0x48u, 0x98u, 0x48u, 0x09u, 0xc1u,
    };
    static const pl_u8 saved_entry_subtract_branch[] = {
        0x48u, 0x89u, 0xc2u, 0x29u, 0xc8u, 0x75u, 0x19u,
    };
    static const pl_u8 high_word_test_branch[] = {
        0x48u, 0x89u, 0xdeu, 0x66u, 0xf7u, 0xc2u, 1u, 0x80u, 0x75u, 0x71u,
    };
    static const pl_u8 high_mask_select[] = {
        0xf7u, 0xc3u, 0u, 0u, 0u, 0x80u,
        0x48u, 0xc7u, 0xc2u, 0xd8u, 0xf5u, 0x8cu, 0x81u,
        0x48u, 0xc7u, 0xc0u, 0xeeu, 0xf5u, 0x8cu, 0x81u,
        0x48u, 0x0fu, 0x45u, 0xd0u,
    };
    static const pl_u8 compare_before_constants[] = {
        0x83u, 0xfeu, 0xecu, 0x48u, 0xc7u, 0xc0u, 0x98u, 0xfeu, 0x8cu, 0x81u,
        0x48u, 0xc7u, 0xc6u, 0xe0u, 0x3du, 0x8du, 0x81u,
    };
    static const pl_u8 byte_select_before_compare[] = {
        0x48u, 0xc7u, 0xc6u, 0xe0u, 0x3du, 0x8du, 0x81u,
        0x84u, 0xc0u, 0x48u, 0xc7u, 0xc0u, 0xbbu, 0x7du, 0x8du, 0x81u,
        0x48u, 0x0fu, 0x45u, 0xf0u, 0x48u, 0x83u, 0xfau, 1u, 0x75u, 0x11u,
    };
    static const pl_u8 magnitude_before_scan[] = {
        0xb9u, 0xffu, 0xffu, 0xffu, 0xffu,
        0x48u, 0xc7u, 0xc6u, 0xfau, 6u, 0x8du, 0x81u,
        0x48u, 0xc7u, 0xc7u, 0x1eu, 7u, 0x8du, 0x81u,
        0x48u, 0x89u, 0xd0u, 0x48u, 0xf7u, 0xd8u, 0x48u, 0x0fu, 0x48u, 0xc2u,
        0x48u, 0x0fu, 0xbdu, 0xc8u,
    };
    static const pl_u8 shared_bit_fill[] = {
        0x4cu, 0x89u, 0xc3u, 0x48u, 0xc1u, 0xe8u, 2u, 0x48u, 0x09u, 0xc7u,
        0x48u, 0x89u, 0xf8u, 0x48u, 0x83u, 0xecu, 8u,
        0x48u, 0xc1u, 0xe8u, 4u, 0x48u, 0x09u, 0xc7u, 0x48u, 0x89u, 0xf8u,
        0x48u, 0xc1u, 0xe8u, 8u, 0x48u, 0x09u, 0xc7u, 0x48u, 0x89u, 0xf8u,
        0x48u, 0xc1u, 0xe8u, 16u, 0x48u, 0x09u, 0xc7u, 0x48u, 0x89u, 0xf8u,
        0x48u, 0xc1u, 0xe8u, 32u, 0x48u, 0x09u, 0xc7u, 0x48u, 0x83u, 0xc7u, 1u,
    };
    static const pl_u8 nonzero_before_divide[] = {
        0xbau, 1u, 0u, 0u, 0u, 0xbeu, 0xe8u, 3u, 0u, 0u,
        0x48u, 0xc7u, 0xc7u, 0x4fu, 9u, 0x8du, 0x81u,
        0x85u, 0xc0u, 0x0fu, 0x44u, 0xc2u, 0x31u, 0xd2u,
    };
    static const pl_u8 shared_shifted_product[] = {
        0x48u, 0xc7u, 0xc7u, 0u, 0xa7u, 0x8bu, 0x81u,
        0x89u, 0xcau, 0x48u, 0x89u, 0xceu, 0xc1u, 0xeau, 5u,
        0x48u, 0x6bu, 0xd2u, 0x70u, 0x48u, 0x01u, 0xd1u, 0xebu, 0x82u,
    };
    /* Three-word ARX mixing retains the sum and rotated difference at each
     * stage. Recomputing a tree per final register loses those shared edges. */
    static const pl_u8 shared_arx_mix[] = {
        0x44u, 0x01u, 0xeau, 0x41u, 0x83u, 0xe8u, 0x0cu,
        0x48u, 0x83u, 0xc7u, 0x0cu, 0x29u, 0xc5u,
        0x48u, 0x83u, 0xc6u, 0x0cu, 0x41u, 0x01u, 0xecu,
        0x89u, 0xc5u, 0x01u, 0xd0u, 0xc1u, 0xc5u, 0x04u,
        0x44u, 0x31u, 0xe5u, 0x29u, 0xeau, 0x41u, 0x89u, 0xd4u,
        0x89u, 0xeau, 0x01u, 0xc5u, 0xc1u, 0xc2u, 0x06u,
        0x44u, 0x31u, 0xe2u, 0x29u, 0xd0u, 0x41u, 0x89u, 0xc4u,
        0x89u, 0xd0u, 0x01u, 0xeau, 0xc1u, 0xc0u, 0x08u,
        0x44u, 0x31u, 0xe0u, 0x41u, 0x89u, 0xc4u, 0x29u, 0xc5u,
        0x01u, 0xd0u, 0x41u, 0xc1u, 0xc4u, 0x10u, 0x41u, 0x31u, 0xecu,
        0x44u, 0x89u, 0xe5u, 0x44u, 0x29u, 0xe2u, 0x41u, 0x01u, 0xc4u,
        0xc1u, 0xcdu, 0x0du, 0x31u, 0xeau, 0x89u, 0xd5u, 0x29u, 0xd0u,
        0x44u, 0x01u, 0xe2u, 0xc1u, 0xc5u, 0x04u, 0x31u, 0xe8u,
        0x41u, 0x83u, 0xf8u, 0x0cu, 0x0fu, 0x8fu, 0x31u, 0xffu, 0xffu, 0xffu,
    };
    static const pl_u8 high_byte_select[] = {
        0x48u, 0xc7u, 0xc2u, 0xe0u, 0x3du, 0x8du, 0x81u, 0xf6u, 0xc4u, 1u,
        0x48u, 0xc7u, 0xc1u, 0xe0u, 0x3du, 0x8du, 0x81u,
        0x48u, 0xc7u, 0xc0u, 0x1eu, 0x0fu, 0x8du, 0x81u,
        0x48u, 0xc7u, 0xc7u, 0x70u, 0xabu, 0x8bu, 0x81u,
        0x48u, 0x0fu, 0x45u, 0xc1u, 0x48u, 0x89u, 0xf1u, 0x48u, 0x89u, 0xc6u,
    };
    static const pl_u8 conditional_bit_projection[] = {
        0x89u, 0xf0u, 0x25u, 0xc3u, 0xffu, 0x77u, 0u,
        0x48u, 0x89u, 0xc2u, 0x80u, 0xceu, 0x10u,
        0x81u, 0xe6u, 0u, 0u, 0x10u, 0u, 0x48u, 0x0fu, 0x45u, 0xc2u,
        0x89u, 0xcau, 0x83u, 0xcau, 2u, 0xf6u, 0xc4u, 2u, 0x48u, 0x89u, 0xc6u,
    };
    const pl_u8 *cut_source[] = {
        masked_shift_compare, address_subtract_flags, word_test_boolean, add_carry_branch,
        conditional_borrow_fanout, signed_overlay, saved_entry_subtract_branch,
        high_word_test_branch, high_mask_select, compare_before_constants,
        byte_select_before_compare, magnitude_before_scan, shared_bit_fill,
        nonzero_before_divide, shared_shifted_product, high_byte_select,
        conditional_bit_projection, shared_arx_mix };
    const pl_u32 cut_length[] = {
        sizeof masked_shift_compare, sizeof address_subtract_flags,
        sizeof word_test_boolean, sizeof add_carry_branch, sizeof conditional_borrow_fanout,
        sizeof signed_overlay, sizeof saved_entry_subtract_branch,
        sizeof high_word_test_branch, sizeof high_mask_select, sizeof compare_before_constants,
        sizeof byte_select_before_compare, sizeof magnitude_before_scan, sizeof shared_bit_fill,
        sizeof nonzero_before_divide, sizeof shared_shifted_product,
        sizeof high_byte_select, sizeof conditional_bit_projection, sizeof shared_arx_mix };
    /* magnitude_before_scan needs its zero-input seed as well as the absolute
     * value and BSR. The old six-work limit accepted a missing architectural
     * input, not an equivalent lower-work implementation. */
    const pl_u32 cut_work[] = { 6u, 4u, 5u, 7u, 10u, 9u, 3u, 3u, 4u, 3u, 6u, 7u, 17u, 5u, 7u, 8u, 10u, 39u };
    for (pl_u32 cut = 0u; cut < sizeof cut_work / sizeof cut_work[0]; ++cut) {
        status = select_projected(cut_source[cut], cut_length[cut],
            (1u << PL_X86_LOCAL_COUNT) - 1u,
            &selected, output, &written, &projected);
        if (!status && projected.end != 0x1000u + cut_length[cut]) {
            fprintf(stderr, "native x86 selection: RED (expression cut %u "
                "formed %llu/%u source bytes)\n", cut,
                (unsigned long long)(projected.end - projected.start), cut_length[cut]);
            return 225;
        }
        if (status || !selected.normalized_family_present
                || selected.output_work > cut_work[cut]
                || (cut_source[cut] == conditional_bit_projection && selected.output_span > 4u)) {
            pl_x86_native_candidates failed = { 0 };
            (void)candidates_projected(cut_source[cut], cut_length[cut],
                (1u << PL_X86_LOCAL_COUNT) - 1u, &failed);
            fprintf(stderr, "native x86 selection: RED (expression cut %u "
                "status=%d work/span=%u/%u rejection=%x/%x)\n", cut,
                status, selected.output_work, selected.output_span,
                failed.diagnostic.blocking_work, failed.diagnostic.blocking_opcode);
            if (!status) {
                fprintf(stderr, "  generated:");
                for (pl_u32 i = 0u; i < written; ++i) fprintf(stderr, " %02x", output[i]);
                fputc('\n', stderr);
            }
            for (pl_u32 i = 0u; i < failed.count; ++i)
                fprintf(stderr, "  candidate %u work/span=%u/%u source=%u\n", i,
                    failed.candidate[i].output_work, failed.candidate[i].output_span,
                    failed.candidate[i].copied_source);
            pl_x86_alu_schedule_diagnostic schedule = { 0 };
            int schedule_status = pl_x86_select_alu_schedule_diagnostic(&projected, &schedule);
            fprintf(stderr, "  schedule status=%d changed=%x flags=%u protected=%x\n",
                schedule_status, schedule.changed, schedule.final_flag_node,
                schedule.standalone_flag_dependencies);
            for (pl_u32 local = 0u; !schedule_status && local < PL_X86_GPR_COUNT; ++local)
                if (schedule.changed & (1u << local))
                    fprintf(stderr, "    local %u entries=%x publications=%x\n", local,
                        schedule.sources[local], schedule.dependencies[local]);
            print_block_shape(&projected);
            return 225;
        }
        if (cut_source[cut] == conditional_bit_projection)
            printf("conditional bit projection: green (work/span/bytes=%u/%u/%u)\n",
                selected.output_work, selected.output_span, selected.output_bytes);
    }
    static const pl_u8 address_data[8192] = { 0 };
    pl_x86_map magnitude_maps[] = {
        { magnitude_before_scan, 0xffffffff81205340ull,
          sizeof magnitude_before_scan, sizeof magnitude_before_scan,
          PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u },
        { address_data, 0xffffffff818d0000ull, sizeof address_data,
          sizeof address_data, PL_ELF_FLAG_READ, 2u },
    };
    pl_x86_image magnitude_image = { magnitude_maps, 2u, 0u, magnitude_maps[0].address };
    status = select_image_projected(&magnitude_image, sizeof magnitude_before_scan,
        (1u << PL_X86_LOCAL_COUNT) - 1u, 1, &selected, output, &written, &projected);
    if (status || !selected.normalized_family_present
            || projected.end != magnitude_image.entry + sizeof magnitude_before_scan) {
        fprintf(stderr, "native x86 selection: RED (address-bound magnitude "
            "status=%d work/span=%u/%u normalized=%u)\n", status,
            selected.output_work, selected.output_span, selected.normalized_family_present);
        print_block_shape(&projected);
        return 225;
    }
    static const pl_u8 shared_signed_shift[] = {
        0x89u, 0xc2u, 0xd3u, 0xfau, 0x48u, 0x63u, 0xc2u,
        0x83u, 0xfeu, 2u, 0x0fu, 0x85u, 0x8au, 0xfdu, 0xffu, 0xffu,
    };
    pl_x86_native_candidates shared_shift_candidates = { 0 };
    status = candidates_projected(shared_signed_shift, sizeof shared_signed_shift,
        (1u << PL_X86_LOCAL_COUNT) - 1u, &shared_shift_candidates);
    pl_u32 shift_min_span = 0u, shift_min_work = 0u;
    if (!status) status = pl_x86_candidates_select_joint_minimum(
        &shared_shift_candidates, 0u, 0u, &selected, &shift_min_span, &shift_min_work);
    if (status || !selected.normalized_family_present
            || shift_min_work > 5u || shift_min_span > 3u) {
        fprintf(stderr, "native x86 selection: RED (shared signed shift "
            "status=%d independent span/work=%u/%u)\n", status, shift_min_span, shift_min_work);
        for (pl_u32 i = 0u; i < shared_shift_candidates.count; ++i) {
            pl_u32 size = 0u;
            const pl_x86_native_selection *candidate = &shared_shift_candidates.candidate[i];
            fprintf(stderr, " candidate source=%u span/work/bytes=%u/%u/%u:",
                candidate->copied_source, candidate->output_span, candidate->output_work,
                candidate->output_bytes);
            if (!write_candidate(shared_signed_shift, sizeof shared_signed_shift,
                    0x1000u, candidate, output, sizeof output, &size))
                for (pl_u32 j = 0u; j < size; ++j) fprintf(stderr, " %02x", output[j]);
            fputc('\n', stderr);
        }
        return 226;
    }
    pl_x86_native_candidates aligned_candidates = { 0 };
    static const pl_u8 signed_clamp[] = {
        0xbau, 0xffu, 0xffu, 0xffu, 0x7fu, 0x48u, 0x39u, 0xd0u,
        0x48u, 0x0fu, 0x4fu, 0xc2u, 0x48u, 0x98u,
    };
    pl_x86_native_candidates clamp_candidates = { 0 };
    status = candidates_projected(signed_clamp, sizeof signed_clamp,
        (1u << PL_X86_LOCAL_COUNT) - 1u, &clamp_candidates);
    pl_u32 clamp_span = 0u, clamp_work = 0u;
    if (!status) status = pl_x86_candidates_select_joint_minimum(
        &clamp_candidates, 0u, 0u, &selected, &clamp_span, &clamp_work);
    if (status || !selected.normalized_family_present || clamp_work > 4u || clamp_span > 3u) {
        fprintf(stderr, "native x86 selection: RED (signed clamp status=%d span/work=%u/%u)\n",
            status, clamp_span, clamp_work);
        for (pl_u32 i = 0u; i < clamp_candidates.count; ++i) {
            const pl_x86_native_selection *candidate = &clamp_candidates.candidate[i];
            pl_u32 size = 0u;
            fprintf(stderr, " candidate source=%u span/work/bytes=%u/%u/%u:", candidate->copied_source,
                candidate->output_span, candidate->output_work, candidate->output_bytes);
            if (!write_candidate(signed_clamp, sizeof signed_clamp, 0x1000u,
                    candidate, output, sizeof output, &size))
                for (pl_u32 j = 0u; j < size; ++j) fprintf(stderr, " %02x", output[j]);
            fputc('\n', stderr);
        }
        return 227;
    }
    status = candidates_projected(
        aligned_stack_fanout_source, sizeof aligned_stack_fanout_source,
        (1u << PL_X86_LOCAL_COUNT) - 1u, &aligned_candidates);
    pl_u32 aligned_span = 0u, aligned_work = 0u;
    if (!status) status = pl_x86_candidates_select_joint_minimum(
        &aligned_candidates, 0u, 0u, &selected, &aligned_span, &aligned_work);
    if (status || !selected.normalized_family_present
            || aligned_work > 9u || aligned_span > 7u) {
        fprintf(stderr, "native x86 selection: RED (aligned stack fanout "
                "status=%d independent span/work=%u/%u)\n",
                status, aligned_span, aligned_work);
        for (pl_u32 i = 0u; i < aligned_candidates.count; ++i)
            fprintf(stderr, "  candidate span/work/bytes=%u/%u/%u\n",
                    aligned_candidates.candidate[i].output_span,
                    aligned_candidates.candidate[i].output_work,
                    aligned_candidates.candidate[i].output_bytes);
        return 221;
    }
    status = select_projected(
        wide_shift_narrow_flags_source, sizeof wide_shift_narrow_flags_source,
        (1u << PL_X86_LOCAL_COUNT) - 1u,
        &selected, output, &written, &projected);
    if (status || !selected.supported || !selected.normalized_family_present
            || selected.output_work > 8u || selected.output_span > 3u) {
        fprintf(stderr,
                "native x86 selection: RED (wide shift / narrow flags "
                "status=%d source/normalized=%u/%u work/span/bytes=%u/%u/%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                selected.output_work, selected.output_span,
                selected.output_bytes);
        print_block_shape(&projected);
        return 218;
    }
    status = select(
        high8_projection_source, sizeof high8_projection_source,
        0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !selected.direct_alu_frame || !selected.direct_nested_frame
            || selected.output_work != 10u || selected.output_span != 2u
            || selected.output_bytes != sizeof high8_projection_result
            || written != sizeof high8_projection_result
            || memcmp(output, high8_projection_result,
                      sizeof high8_projection_result)) {
        fprintf(stderr,
                "native x86 selection: RED (high8 projection "
                "status=%d source/normalized/alu/nested=%u/%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_alu_frame,
                (unsigned)selected.direct_nested_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        fprintf(stderr, "high8 emitted bytes:");
        for (pl_u32 byte = 0u; byte < written; ++byte)
            fprintf(stderr, "%02x", output[byte]);
        fprintf(stderr, "\n");
        return 217;
    }
    status = select(
        stable_predicate_source_jump,
        sizeof stable_predicate_source_jump, 0x1000u,
        &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_frame || !selected.direct_alu_frame
            || selected.output_work != 5u || selected.output_span != 3u
            || selected.output_bytes
               != sizeof stable_predicate_source_result
            || written != sizeof stable_predicate_source_result
            || memcmp(output, stable_predicate_source_result,
                      sizeof stable_predicate_source_result)) {
        fprintf(stderr,
                "native x86 selection: RED (stable predicate source "
                "status=%d source/direct/alu=%u/%u/%u "
                "work/span/bytes=%u/%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.direct_frame,
                (unsigned)selected.direct_alu_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 56;
    }
    projected = (pl_x86_block){ 0 };
    status = select_projected(
        neg_sbb_flag_chain, sizeof neg_sbb_flag_chain,
        (1u << PL_X86_LOCAL_COUNT) - 1u,
        &selected, output, &written, &projected);
    int chained_borrow = 0;
    int entry_borrow = 0;
    for (pl_u32 node_index = 0u;
            !status && node_index < projected.plan.node_count; ++node_index) {
        const pl_node *node = &projected.plan.nodes[node_index];
        if (node->opcode != PL_OPCODE_X86_CONDITION
                || node->argument_count != 2u)
            continue;
        const pl_operand *argument =
            &projected.plan.arguments[node->argument_at];
        if (argument[1].kind != PL_OPERAND_CONST
                || argument[1].value != 2u)
            continue;
        entry_borrow |= argument[0].kind == PL_OPERAND_LOCAL
                     && argument[0].value == PL_X86_RFLAGS_LOCAL;
        chained_borrow |= argument[0].kind == PL_OPERAND_NODE;
    }
    if (status || !selected.supported || !chained_borrow || entry_borrow) {
        fprintf(stderr,
                "native x86 selection: RED (NEG->SBB flag chain "
                "status=%d supported/chained/entry=%u/%d/%d "
                "work/span/bytes=%u/%u/%u)\n",
                status, (unsigned)selected.supported,
                chained_borrow, entry_borrow,
                selected.output_work, selected.output_span,
                selected.output_bytes);
        print_block_shape(&projected);
        return 50;
    }
    projected = (pl_x86_block){ 0 };
    status = select_projected(
        mul_add_carry_source, sizeof mul_add_carry_source,
        abi_return_outputs,
        &selected, output, &written, &projected);
    if (status || !selected.supported || selected.copied_source
            || !selected.normalized_family_present
            || !selected.direct_mul_add_carry_frame
            || selected.output_work != 8u || selected.output_span != 5u
            || selected.output_bytes != sizeof mul_add_carry_result
            || written != sizeof mul_add_carry_result
            || projected.plan.node_count != 9u
            || projected.plan.span != 5u
            || memcmp(output, mul_add_carry_result,
                      sizeof mul_add_carry_result)) {
        fprintf(stderr,
                "native x86 selection: RED (mul-add-carry normal form "
                "status=%d source/normalized/direct=%u/%u/%u "
                "work/span/bytes=%u/%u/%u plan=%u/%u written=%u)\n",
                status, (unsigned)selected.copied_source,
                (unsigned)selected.normalized_family_present,
                (unsigned)selected.direct_mul_add_carry_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, projected.plan.node_count,
                projected.plan.span, written);
        print_block_shape(&projected);
        return 49;
    }
    status = select(shared_sub_source, sizeof shared_sub_source,
                    0x1000u, &selected, output, &written);
    if (status || !selected.supported || selected.copied_source
            || !selected.direct_shared_sub_frame
            || selected.output_work != 6u || selected.output_span != 4u
            || selected.output_bytes != sizeof shared_sub_result
            || written != sizeof shared_sub_result
            || memcmp(output, shared_sub_result, sizeof shared_sub_result)) {
        fprintf(stderr,
                "native x86 selection: RED (shared subtraction "
                "status=%d direct=%u work/span/bytes=%u/%u/%u "
                "written=%u)\n", status,
                (unsigned)selected.direct_shared_sub_frame,
                selected.output_work, selected.output_span,
                selected.output_bytes, written);
        return 229;
    }
    /* The final TEST observes the entry RAX, while RDX receives RAX-RBX.
     * Computing the subtraction in RAX first changes the TEST predicate. */
    static const pl_u8 entry_test_after_subtract[] = {
        0x48, 0x89, 0xc2,       /* mov rdx, rax */
        0x48, 0x29, 0xda,       /* sub rdx, rbx */
        0x48, 0x85, 0xc0,       /* test rax, rax */
        0xb8, 0xff, 0xff, 0xff, 0xff, /* mov eax, -1 */
    };
    status = select_projected(entry_test_after_subtract,
        sizeof entry_test_after_subtract,
        (1u << 0u) | (1u << 2u) | (1u << PL_X86_RFLAGS_LOCAL),
        &selected, output, &written, 0);
    if (status || !selected.supported || !selected.copied_source
            || written != sizeof entry_test_after_subtract
            || memcmp(output, entry_test_after_subtract,
                      sizeof entry_test_after_subtract)) {
        fprintf(stderr,
            "native x86 selection: RED (entry TEST after independent "
            "subtraction status=%d source=%u written=%u)\n",
            status, (unsigned)selected.copied_source, written);
        return 230;
    }
    /* Two CMOVs consume different flag generations. The first observes
     * entry RFLAGS; TEST r8 produces the second. Moving TEST ahead of both
     * CMOVs makes the first select depend on r8 instead of entry RCX. */
    static const pl_u8 independent_cmov_flags[] = {
        0x41, 0x89, 0xd6,             /* mov r14d, edx */
        0x4c, 0x8d, 0x6c, 0x24, 0x20, /* lea r13, [rsp+0x20] */
        0x48, 0x8d, 0x6c, 0x24, 0x14, /* lea rbp, [rsp+0x14] */
        0x4c, 0x0f, 0x45, 0xe9,       /* cmovne r13, rcx */
        0x4d, 0x85, 0xc0,             /* test r8, r8 */
        0x49, 0x0f, 0x45, 0xe8,       /* cmovne rbp, r8 */
        0x31, 0xd2,                   /* xor edx, edx */
    };
    status = select(independent_cmov_flags, sizeof independent_cmov_flags,
                    0x1000u, &selected, output, &written);
    if (status || !selected.supported || !selected.copied_source
            || written != sizeof independent_cmov_flags
            || memcmp(output, independent_cmov_flags,
                      sizeof independent_cmov_flags)) {
        fprintf(stderr,
            "native x86 selection: RED (independent CMOV flag generations "
            "status=%d source=%u written=%u)\n",
            status, (unsigned)selected.copied_source, written);
        return 231;
    }
    printf("native x86 selection: green (normalized state directly emits shortest acyclic parallel copies and constants; source-relative fields rebound)\n");
    return 0;
}

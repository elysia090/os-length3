#include "internal/block.h"

#include <stdio.h>

static int same_bytes(const pl_u8 *left, const pl_u8 *right, pl_u32 bytes)
{
    for (pl_u32 index = 0u; index < bytes; ++index)
        if (left[index] != right[index]) return 0;
    return 1;
}

static int spell(const pl_x86_frontend *frontend,
                 const pl_x86_block *block, pl_u32 closed,
                 pl_u8 bytes[2048], pl_u32 *written)
{
    pl_u32 measured = 0u;
    int status = pl_x86_block_observation_measure(
        frontend, block, closed, &measured);
    if (!status)
        status = pl_x86_block_observation_write(
            frontend, block, closed, bytes, 2048u, written);
    return !status && measured != *written ? PL_ERROR_BLOCK : status;
}

static int spell_control(const pl_x86_block *block, pl_u32 closed,
                         pl_u8 bytes[2048], pl_u32 *written)
{
    pl_u32 measured = 0u;
    int status = pl_x86_block_control_measure(block, closed, &measured);
    if (!status)
        status = pl_x86_block_control_write(
            block, closed, bytes, 2048u, written);
    return !status && measured != *written ? PL_ERROR_BLOCK : status;
}

static int spell_law(const pl_x86_frontend *frontend,
                     const pl_x86_block *block, pl_u32 closed,
                     pl_u8 bytes[2048], pl_u32 *written)
{
    pl_u32 measured = 0u;
    int status = pl_x86_block_law_measure(
        frontend, block, closed, &measured);
    if (!status)
        status = pl_x86_block_law_write(
            frontend, block, closed, bytes, 2048u, written);
    return !status && measured != *written ? PL_ERROR_BLOCK : status;
}

static int spell_bindings(const pl_x86_block *block, pl_u32 closed,
                          pl_u8 bytes[2048], pl_u32 *written)
{
    pl_u32 measured = 0u;
    int status = pl_x86_block_bindings_measure(
        block, closed, &measured);
    if (!status)
        status = pl_x86_block_bindings_write(
            block, closed, bytes, 2048u, written);
    return !status && measured != *written ? PL_ERROR_BLOCK : status;
}

int main(void)
{
    static const pl_x86_image image = { 0 };
    static const pl_x86_frontend frontend = { &image };
    pl_node left_node[] = { { 9u, 0u, 2u } };
    pl_operand left_argument[] = {
        { PL_OPERAND_LOCAL, 7u }, { PL_OPERAND_CONST, 19u },
    };
    pl_operand left_local[] = {
        { PL_OPERAND_NODE, 1u }, { PL_OPERAND_LOCAL, 1u },
    };
    pl_u32 left_offset[] = { 0u, 1u };
    pl_u32 left_wave[] = { 1u };
    pl_x86_block left = { 0 };
    left.start = 0x1000u;
    left.end = 0x1004u;
    left.successor[0] = 0x2000u;
    left.successor_count = 1u;
    left.kind = PL_X86_BLOCK_DIRECT;
    left.flow = PL_X86_FLOW_JUMP;
    left.plan = (pl_plan){
        3u, 8u, 9u, 1u, 0u, 1u,
        left_node, 1u, left_argument, 2u,
        0, 0u, left_local, 2u, left_offset, left_wave,
    };

    pl_node moved_node[] = { { 9u, 0u, 2u } };
    pl_operand moved_argument[] = {
        { PL_OPERAND_LOCAL, 7u }, { PL_OPERAND_CONST, 19u },
    };
    pl_operand moved_local[] = {
        { PL_OPERAND_NODE, 1u }, { PL_OPERAND_LOCAL, 1u },
    };
    pl_u32 moved_offset[] = { 0u, 1u, 1u };
    pl_u32 moved_wave[] = { 1u };
    pl_x86_block moved = left;
    moved.start = 0x9000u;
    moved.end = 0x9010u;
    moved.successor[0] = 0xa000u;
    moved.source_work = 999u;
    moved.plan = (pl_plan){
        99u, 40u, 70u, 30u, 0u, 2u,
        moved_node, 1u, moved_argument, 2u,
        0, 0u, moved_local, 2u, moved_offset, moved_wave,
    };

    pl_u8 left_bytes[2048], moved_bytes[2048], changed_bytes[2048];
    pl_u8 left_control[2048], moved_control[2048];
    pl_u8 left_law[2048], moved_law[2048];
    pl_u8 left_bindings[2048], moved_bindings[2048];
    pl_u32 left_written = 0u, moved_written = 0u, changed_written = 0u;
    pl_u32 left_control_written = 0u, moved_control_written = 0u;
    pl_u32 left_law_written = 0u, moved_law_written = 0u;
    pl_u32 left_binding_written = 0u, moved_binding_written = 0u;
    int status = spell(&frontend, &left, 1u, left_bytes, &left_written);
    if (!status)
        status = spell(
            &frontend, &moved, 1u, moved_bytes, &moved_written);
    if (!status && (left_written != moved_written
            || !same_bytes(left_bytes, moved_bytes, left_written)))
        status = PL_ERROR_BLOCK;

    moved_argument[1].value = 23u;
    if (!status)
        status = spell(
            &frontend, &moved, 1u, changed_bytes, &changed_written);
    if (!status && (left_written != changed_written
            || same_bytes(left_bytes, changed_bytes, left_written)))
        status = PL_ERROR_BLOCK;

    /* A lifted constant is not an instruction law. The exact immediate
     * response still differs because the binding row remains authoritative. */
    if (!status)
        status = spell_law(
            &frontend, &left, 1u, left_law, &left_law_written);
    if (!status)
        status = spell_law(
            &frontend, &moved, 1u, moved_law, &moved_law_written);
    if (!status)
        status = spell_bindings(
            &left, 1u, left_bindings, &left_binding_written);
    if (!status)
        status = spell_bindings(
            &moved, 1u, moved_bindings, &moved_binding_written);
    if (!status && (left_law_written != moved_law_written
            || !same_bytes(left_law, moved_law, left_law_written)
            || (left_binding_written == moved_binding_written
                && same_bytes(left_bindings, moved_bindings,
                              left_binding_written))))
        status = PL_ERROR_BLOCK;

    /* The release control shell must not repeat the plan.  Its separate
     * topology/parameter ranks are substituted by the complete publisher. */
    if (!status)
        status = spell_control(
            &left, 1u, left_control, &left_control_written);
    if (!status)
        status = spell_control(
            &moved, 1u, moved_control, &moved_control_written);
    if (!status && (left_control_written != moved_control_written
            || !same_bytes(
                left_control, moved_control, left_control_written)))
        status = PL_ERROR_BLOCK;
    moved_argument[1].value = 19u;

    /* Once an arm is external, its exact target is observable. */
    if (!status)
        status = spell(
            &frontend, &moved, 0u, changed_bytes, &changed_written);
    if (!status && (left_written == changed_written
            && same_bytes(left_bytes, changed_bytes, left_written)))
        status = PL_ERROR_BLOCK;

    if (!status)
        status = spell_control(
            &left, 0u, left_control, &left_control_written);
    if (!status)
        status = spell_control(
            &moved, 0u, moved_control, &moved_control_written);
    if (!status && (left_control_written == moved_control_written
            && same_bytes(
                left_control, moved_control, left_control_written)))
        status = PL_ERROR_BLOCK;

    if (status) {
        fprintf(stderr, "canonical block observation: RED (%d)\n", status);
        return 1;
    }
    printf("canonical block observation: green "
           "(53-path law/binding split preserves exact response)\n");
    return 0;
}

/* Direct-control closure has no successor-free graph result. */

#include <stdio.h>

#include "../src/internal/closure.h"

typedef struct {
    pl_u64 address;
    pl_u32 rank;
} known_rank;

static int resolve(void *opaque, pl_u64 address, pl_u32 *rank)
{
    const known_rank *known = opaque;
    if (address != known->address) return 0;
    *rank = known->rank;
    return 1;
}

static int close_bytes(const pl_u8 *bytes, pl_u64 byte_count,
                       const known_rank *known, pl_direct_block *direct)
{
    pl_x86_map map = {
        bytes, 0x1000u, byte_count, byte_count,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image image = { &map, 1u, 0u, 0x1000u };
    pl_x86_frontend frontend;
    pl_x86_instruction instruction;
    pl_u8 first[4096], second[4096];
    pl_x86_block_workspace workspace = {
        first, second, sizeof first, 64u,
    };
    int status = pl_x86_frontend_open(&image, &frontend);
    if (!status)
        status = pl_x86_frontend_decode(
            &frontend, image.entry, &instruction);
    if (!status)
        status = pl_x86_close_direct(
            &frontend, &workspace, &instruction, resolve,
            (void *)known, direct);
    return status;
}

int main(void)
{
    static const pl_u8 loop[] = { 0xebu, 0xfeu };
    static const pl_u8 outside[] = { 0xe9u, 0u, 0u, 0u, 0u };
    static const pl_u8 fault[] = { 0x0fu, 0x0bu };
    static const pl_u8 halt[] = { 0xf4u, 0xc3u };
    const known_rank known = { 0x1000u, 17u };
    const known_rank halt_continuation = { 0x1001u, 23u };
    pl_direct_block direct = { 0 };
    int status = close_bytes(loop, sizeof loop, &known, &direct);
    const char *stage = "loop";
    if (!status && (direct.result_kind != PL_DIRECT_FUNCTION
            || direct.result_payload != known.rank
            || direct.has_branch_predicate))
        status = PL_ERROR_BLOCK;
    if (!status) {
        stage = "outside";
        status = close_bytes(outside, sizeof outside, &known, &direct);
    }
    if (!status && direct.result_kind != PL_DIRECT_RESOLVE)
        status = PL_ERROR_BLOCK;
    if (!status) {
        stage = "fault";
        status = close_bytes(fault, sizeof fault, &known, &direct);
    }
    if (!status && (direct.result_kind != PL_DIRECT_FAULT
            || direct.result_payload != 6u))
        status = PL_ERROR_BLOCK;
    if (!status) {
        stage = "halt";
        status = close_bytes(
            halt, sizeof halt, &halt_continuation, &direct);
    }
    if (!status && (direct.result_kind != PL_DIRECT_HALT
            || direct.result_payload != halt_continuation.rank
            || direct.next_rip != 1u || !direct.next_rip_relative))
        status = PL_ERROR_BLOCK;
    if (status) {
        fprintf(stderr, "direct-control closure: RED (%s, %d)\n",
                stage, status);
        return 1;
    }
    printf("direct-control closure: green "
           "(function/resolve/fault/halt-continuation; "
           "no residual result type)\n");
    return 0;
}

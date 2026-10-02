#define _GNU_SOURCE

#include "../src/internal/compile-elf.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>

static int rejected_grid_check(void)
{
    static const pl_u8 bytes[] = {
        0xb8u, 0x2au, 0x00u, 0x00u, 0x00u, 0xc3u,
    };
    pl_x86_map map = {
        bytes, 0x1000u, sizeof bytes, sizeof bytes,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image image = { &map, 1u, 0u, 0x1000u };
    const pl_u64 entries[] = { 0x1000u };
    const pl_x86_code_grid invalid[] = {
        { 0x1000u, 1u, 0u, 1u, PL_X86_CODE_GRID_SOURCE_IDENTITY },
        { 0x1001u, 1u, 1u, 1u, PL_X86_CODE_GRID_SOURCE_IDENTITY },
    };
    for (size_t index = 0u; index < sizeof invalid / sizeof invalid[0]; ++index) {
        pl_u64 workspace_bytes = 0u;
        int status = pl_x86_native_workspace_measure(
            sizeof bytes, &workspace_bytes);
        pl_u8 *workspace = status ? 0 : malloc((size_t)workspace_bytes);
        if (status || !workspace) return 2;
        pl_u8 output[64u];
        pl_x86_native_population population;
        pl_x86_native_layout layout;
        status = pl_x86_native_write(
            &image, entries, 1u, 0x2000u, output, sizeof output,
            workspace, workspace_bytes, &population, &layout);
        /* Reopening the physical layout has no diagnostic population owner.
         * Invalid grids must still return an error instead of dereferencing
         * that optional owner: zero stride and a non-boundary cell are both
         * rejected before any liveness scratch is consumed. */
        pl_u32 live[8u];
        pl_u32 scratch[128u];
        if (!status)
            status = pl_x86_native_project_live_outputs(
                &image, workspace, workspace_bytes, &population,
                &invalid[index], 1u, live, 8u,
                (pl_u8 *)(void *)scratch, sizeof scratch);
        free(workspace);
        if (status != PL_ERROR_BLOCK) {
            fprintf(stderr,
                    "native layout: RED (invalid grid %zu status=%d)\n",
                    index, status);
            return 1;
        }
    }
    return 0;
}

int main(void)
{
    int grid_status = rejected_grid_check();
    if (grid_status) return grid_status;
    /* call body; ret; body: mov eax,42; ret.  The final mov/ret is an
     * unreachable lexical suffix, as can occur inside one linked FDE.  The
     * call admits its target and return continuation, while the FDE boundary
     * must project past the suffix without materializing it. */
    static const pl_u8 source[] = {
        0xe8u, 0x01u, 0x00u, 0x00u, 0x00u,
        0xc3u,
        0xb8u, 0x2au, 0x00u, 0x00u, 0x00u, 0xc3u,
        0xb8u, 0x07u, 0x00u, 0x00u, 0x00u, 0xc3u,
    };
    pl_x86_map map = {
        source, 0x1000u, sizeof source, sizeof source,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image image = { &map, 1u, 0u, 0x1000u };
    const pl_u64 entries[] = { 0x1000u };
    pl_u64 workspace_bytes = 0u;
    int status = pl_x86_native_workspace_measure(
        sizeof source, &workspace_bytes);
    pl_u8 *workspace = status ? 0 : malloc((size_t)workspace_bytes);
    void *memory = mmap(0, 4096u, PROT_READ | PROT_WRITE | PROT_EXEC,
                        MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (status || !workspace || memory == MAP_FAILED) return 2;

    pl_x86_native_population population;
    pl_x86_native_layout layout;
    status = pl_x86_native_write(
        &image, entries, 1u, (pl_u64)(uintptr_t)memory,
        memory, 4096u, workspace, workspace_bytes,
        &population, &layout);
    pl_u64 entry = 0u;
    pl_u64 continuation = 0u;
    pl_u64 body = 0u;
    if (!status) status = pl_x86_native_resolve(&layout, 0x1000u, &entry);
    if (!status)
        status = pl_x86_native_resolve(&layout, 0x1005u, &continuation);
    if (!status) status = pl_x86_native_resolve(&layout, 0x1006u, &body);
    pl_u64 unwind_end = 0u;
    int unwind_status = status ? status : pl_x86_native_project_boundary(
        &layout, 0x1000u + sizeof source, &unwind_end);
    pl_u64 synthetic_field = 0u;
    int retained = 0;
    pl_u32 entry_rank = 0xffffffffu;
    pl_u32 continuation_rank = 0xffffffffu;
    pl_u32 body_rank = 0xffffffffu;
    if (!status)
        status = pl_x86_native_rank(&layout, 0x1000u, &entry_rank);
    if (!status)
        status = pl_x86_native_rank(
            &layout, 0x1005u, &continuation_rank);
    if (!status)
        status = pl_x86_native_rank(&layout, 0x1006u, &body_rank);
    int synthetic_status = status ? status : pl_x86_native_project_field(
        &layout, 0x1007u, 4u, &synthetic_field, &retained);
    if (status || population.blocks != 4u
            || population.selected_blocks != 4u
            || population.unselected_blocks
            || population.direct_frame_blocks
                 + population.copied_source_blocks
                 + population.erased_blocks != population.selected_blocks
            || population.direct_frame_source_bytes
                 + population.copied_source_source_bytes
                 + population.erased_source_bytes
               != population.selected_source_bytes
            || population.direct_frame_output_bytes
                 + population.copied_source_output_bytes
               != population.selected_output_bytes
            || layout.output_bytes != 12u
            || layout.fixup_count != 1u
            || layout.offset_count != population.blocks
            || layout.rank_prefix_count != 2u
            || entry_rank != 0u || continuation_rank != 1u
            || body_rank != 2u
            || entry != (pl_u64)(uintptr_t)memory
            || continuation != entry + 5u || body != entry + 6u
            || unwind_status || unwind_end != entry + 12u
            || synthetic_status != PL_ERROR_NATIVE_PROJECT_SYNTHETIC
            || retained) {
        fprintf(stderr,
                "native layout: RED (status=%d blocks=%u/%u output=%u "
                "fixups=%u entry/continuation/body=%llx/%llx/%llx "
                "rank-storage=%u/%u ranks=%u/%u/%u "
                "unwind=%d/%llx synthetic=%d/%d)\n",
                status, population.selected_blocks, population.blocks,
                layout.output_bytes, layout.fixup_count,
                (unsigned long long)entry,
                (unsigned long long)continuation,
                (unsigned long long)body,
                layout.offset_count, layout.rank_prefix_count,
                entry_rank, continuation_rank, body_rank, unwind_status,
                (unsigned long long)unwind_end,
                synthetic_status, retained);
        munmap(memory, 4096u);
        free(workspace);
        return 1;
    }

    union {
        void *object;
        unsigned (*function)(void);
    } callable;
    callable.object = memory;
    unsigned result = callable.function();
    munmap(memory, 4096u);
    free(workspace);
    if (result != 42u) {
        fprintf(stderr, "native layout: RED (result=%u)\n", result);
        return 1;
    }

    /* Two source operations have the same architectural destination.  The
     * normalized one-node affine future must be emitted as one LEA, followed
     * by the independently selected RET block. */
    static const pl_u8 affine_source[] = {
        0x48u, 0x8du, 0x47u, 0x01u,
        0x48u, 0x8du, 0x47u, 0x02u,
        0xc3u,
    };
    pl_x86_map affine_map = {
        affine_source, 0x2000u, sizeof affine_source, sizeof affine_source,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image affine_image = { &affine_map, 1u, 0u, 0x2000u };
    const pl_u64 affine_entries[] = { 0x2000u };
    workspace_bytes = 0u;
    status = pl_x86_native_workspace_measure(
        sizeof affine_source, &workspace_bytes);
    workspace = status ? 0 : malloc((size_t)workspace_bytes);
    memory = mmap(0, 4096u, PROT_READ | PROT_WRITE | PROT_EXEC,
                  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (status || !workspace || memory == MAP_FAILED) return 2;
    status = pl_x86_native_write(
        &affine_image, affine_entries, 1u, (pl_u64)(uintptr_t)memory,
        memory, 4096u, workspace, workspace_bytes,
        &population, &layout);
    entry = 0u;
    if (!status)
        status = pl_x86_native_resolve(&layout, 0x2000u, &entry);
    if (status || population.direct_frame_blocks != 1u
            || population.copied_source_blocks != 1u
            || population.selected_source_bytes != 9u
            || population.selected_output_bytes != 5u
            || layout.output_bytes != 5u) {
        fprintf(stderr,
                "native layout: RED (affine status=%d direct/source=%u/%u "
                "bytes=%llu/%llu layout=%u)\n",
                status, population.direct_frame_blocks,
                population.copied_source_blocks,
                (unsigned long long)population.selected_source_bytes,
                (unsigned long long)population.selected_output_bytes,
                layout.output_bytes);
        munmap(memory, 4096u);
        free(workspace);
        return 1;
    }
    union {
        void *object;
        uint64_t (*function)(uint64_t);
    } affine_callable;
    affine_callable.object = (void *)(uintptr_t)entry;
    uint64_t affine_result = affine_callable.function(40u);
    munmap(memory, 4096u);
    free(workspace);
    if (affine_result != 42u) {
        fprintf(stderr,
                "native layout: RED (affine result=%llu)\n",
                (unsigned long long)affine_result);
        return 1;
    }

    /* The source chooses the long immediate spelling.  Native selection is
     * driven by the closed ALU state, so the ordinary x86 output uses the
     * canonical sign-extended imm8 spelling and executes without a sidecar. */
    static const pl_u8 alu_source[] = {
        0x48u, 0x81u, 0xc0u, 0x02u, 0x00u, 0x00u, 0x00u,
        0xc3u,
    };
    pl_x86_map alu_map = {
        alu_source, 0x3000u, sizeof alu_source, sizeof alu_source,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image alu_image = { &alu_map, 1u, 0u, 0x3000u };
    const pl_u64 alu_entries[] = { 0x3000u };
    workspace_bytes = 0u;
    status = pl_x86_native_workspace_measure(
        sizeof alu_source, &workspace_bytes);
    workspace = status ? 0 : malloc((size_t)workspace_bytes);
    memory = mmap(0, 4096u, PROT_READ | PROT_WRITE | PROT_EXEC,
                  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (status || !workspace || memory == MAP_FAILED) return 2;
    status = pl_x86_native_write(
        &alu_image, alu_entries, 1u, (pl_u64)(uintptr_t)memory,
        memory, 4096u, workspace, workspace_bytes,
        &population, &layout);
    entry = 0u;
    if (!status)
        status = pl_x86_native_resolve(&layout, 0x3000u, &entry);
    if (status || population.direct_frame_blocks != 1u
            || population.copied_source_blocks != 1u
            || population.selected_source_bytes != 8u
            || population.selected_output_bytes != 5u
            || layout.output_bytes != 5u) {
        fprintf(stderr,
                "native layout: RED (ALU status=%d direct/source=%u/%u "
                "bytes=%llu/%llu layout=%u)\n",
                status, population.direct_frame_blocks,
                population.copied_source_blocks,
                (unsigned long long)population.selected_source_bytes,
                (unsigned long long)population.selected_output_bytes,
                layout.output_bytes);
        munmap(memory, 4096u);
        free(workspace);
        return 1;
    }
    union {
        void *object;
        uint64_t (*function)(uint64_t);
    } alu_callable;
    /* The selected block's architectural input is RAX, whereas the SysV C
     * argument arrives in RDI.  Keep that ABI adaptation outside the selected
     * block so the execution check observes precisely the emitted ALU body. */
    pl_u8 *alu_thunk = (pl_u8 *)memory + 64u;
    alu_thunk[0] = 0x48u; /* mov rax,rdi */
    alu_thunk[1] = 0x89u;
    alu_thunk[2] = 0xf8u;
    alu_thunk[3] = 0xe8u; /* call selected block */
    pl_i64 alu_delta = (pl_i64)entry
                     - (pl_i64)(uintptr_t)(alu_thunk + 8u);
    if (alu_delta < INT32_MIN || alu_delta > INT32_MAX) {
        munmap(memory, 4096u);
        free(workspace);
        return 2;
    }
    pl_u32 encoded_delta = (pl_u32)(pl_i32)alu_delta;
    for (pl_u32 byte = 0u; byte < 4u; ++byte)
        alu_thunk[4u + byte] = (pl_u8)(encoded_delta >> (byte * 8u));
    alu_thunk[8] = 0xc3u;
    alu_callable.object = alu_thunk;
    uint64_t alu_result = alu_callable.function(40u);
    munmap(memory, 4096u);
    free(workspace);
    if (alu_result != 42u) {
        fprintf(stderr,
                "native layout: RED (ALU result=%llu)\n",
                (unsigned long long)alu_result);
        return 1;
    }

    static const pl_u8 insert_source[] = {
        0x40u, 0x89u, 0xf8u, /* redundant REX; mov eax,edi */
        0xc3u,
    };
    pl_x86_map insert_map = {
        insert_source, 0x4000u, sizeof insert_source, sizeof insert_source,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image insert_image = { &insert_map, 1u, 0u, 0x4000u };
    const pl_u64 insert_entries[] = { 0x4000u };
    workspace_bytes = 0u;
    status = pl_x86_native_workspace_measure(
        sizeof insert_source, &workspace_bytes);
    workspace = status ? 0 : malloc((size_t)workspace_bytes);
    memory = mmap(0, 4096u, PROT_READ | PROT_WRITE | PROT_EXEC,
                  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (status || !workspace || memory == MAP_FAILED) return 2;
    status = pl_x86_native_write(
        &insert_image, insert_entries, 1u, (pl_u64)(uintptr_t)memory,
        memory, 4096u, workspace, workspace_bytes,
        &population, &layout);
    entry = 0u;
    if (!status)
        status = pl_x86_native_resolve(&layout, 0x4000u, &entry);
    if (status || population.direct_frame_blocks != 1u
            || population.copied_source_blocks != 1u
            || population.selected_source_bytes != 4u
            || population.selected_output_bytes != 3u
            || layout.output_bytes != 3u) {
        fprintf(stderr,
                "native layout: RED (insert status=%d direct/source=%u/%u "
                "bytes=%llu/%llu layout=%u)\n",
                status, population.direct_frame_blocks,
                population.copied_source_blocks,
                (unsigned long long)population.selected_source_bytes,
                (unsigned long long)population.selected_output_bytes,
                layout.output_bytes);
        munmap(memory, 4096u);
        free(workspace);
        return 1;
    }
    union {
        void *object;
        uint64_t (*function)(uint64_t);
    } insert_callable;
    insert_callable.object = (void *)(uintptr_t)entry;
    uint64_t insert_result = insert_callable.function(42u);
    munmap(memory, 4096u);
    free(workspace);
    if (insert_result != 42u) {
        fprintf(stderr,
                "native layout: RED (insert result=%llu)\n",
                (unsigned long long)insert_result);
        return 1;
    }

    /* One out-of-image short jump is a placement seed.  Its three-byte
     * widening pushes the preceding 126-byte jump past rel8 range, proving
     * that the event worklist reaches a candidate already checked earlier;
     * a single forward scan would miss the cascade.  Analysis now publishes
     * only the closed source index, so exercise relaxation through the actual
     * write path.  A zero output address keeps the synthetic external target
     * within rel32 range without making the output buffer executable. */
    pl_u8 cascade_source[130];
    pl_u64 cascade_entries[128];
    for (pl_u32 index = 0u; index < sizeof cascade_source; ++index)
        cascade_source[index] = 0xccu;
    cascade_source[0] = 0xebu;
    cascade_source[1] = 0x7eu;
    cascade_source[64] = 0xebu;
    cascade_source[65] = 0x40u;
    cascade_source[128] = 0xc3u;
    pl_u32 cascade_entry_count = 0u;
    cascade_entries[cascade_entry_count++] = 0x5000u;
    for (pl_u32 coordinate = 2u; coordinate < 64u; ++coordinate)
        cascade_entries[cascade_entry_count++] = 0x5000u + coordinate;
    cascade_entries[cascade_entry_count++] = 0x5040u;
    for (pl_u32 coordinate = 66u; coordinate < 130u; ++coordinate)
        cascade_entries[cascade_entry_count++] = 0x5000u + coordinate;
    pl_x86_map cascade_map = {
        cascade_source, 0x5000u, sizeof cascade_source,
        sizeof cascade_source, PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image cascade_image = {
        &cascade_map, 1u, 0u, 0x5000u,
    };
    workspace_bytes = 0u;
    status = pl_x86_native_workspace_measure(
        sizeof cascade_source, &workspace_bytes);
    workspace = status ? 0 : malloc((size_t)workspace_bytes);
    pl_u8 cascade_output[4096];
    if (!status && workspace)
        status = pl_x86_native_write(
            &cascade_image, cascade_entries, cascade_entry_count, 0u,
            cascade_output, sizeof cascade_output,
            workspace, workspace_bytes, &population, &layout);
    free(workspace);
    if (status || cascade_entry_count != 128u
            || population.relaxation_candidates != 2u
            || population.relaxation_widened != 2u
            || population.relaxation_events != 2u
            || population.relaxation_rechecks < 3u) {
        fprintf(stderr,
                "native layout: RED (rel8 cascade status=%d entries=%u "
                "candidates/widened/events/rechecks=%u/%u/%u/%llu)\n",
                status, cascade_entry_count,
                population.relaxation_candidates,
                population.relaxation_widened,
                population.relaxation_events,
                (unsigned long long)population.relaxation_rechecks);
        return 1;
    }
    /* A dead instruction can precede a retained construction field. The
     * surviving MOV immediate is still the same four linked bytes, merely
     * shifted left by the removed instruction. The dropped immediate has no
     * output field. This exercises the physical source-to-output projection
     * used by executable ELF relocation after live-instruction selection. */
    static const pl_u8 live_field_source[] = {
        0xb9u, 0xffu, 0xffu, 0xffu, 0xffu, /* mov ecx, -1       */
        0xbau, 0x78u, 0x56u, 0x34u, 0x12u, /* mov edx, 0x12345678 */
        0x89u, 0xd1u,                     /* mov ecx, edx      */
        0xebu, 0x00u,                     /* jmp next          */
        0xc3u,                            /* ret               */
    };
    pl_x86_map live_field_map = {
        live_field_source, 0x6000u, sizeof live_field_source,
        sizeof live_field_source,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image live_field_image = {
        &live_field_map, 1u, 0u, 0x6000u,
    };
    const pl_u64 live_field_entries[] = { 0x6000u };
    workspace_bytes = 0u;
    status = pl_x86_native_workspace_measure(
        sizeof live_field_source, &workspace_bytes);
    workspace = status ? 0 : malloc((size_t)workspace_bytes);
    pl_u8 live_field_output[64u];
    if (!status && workspace)
        status = pl_x86_native_write(
            &live_field_image, live_field_entries, 1u, 0x7000u,
            live_field_output, sizeof live_field_output,
            workspace, workspace_bytes, &population, &layout);
    pl_u64 retained_field = 0u, dropped_field = 0u;
    int retained_live = 0, retained_dead = 0;
    if (!status)
        status = pl_x86_native_project_field(
            &layout, 0x6006u, 4u, &retained_field, &retained_live);
    if (!status)
        status = pl_x86_native_project_field(
            &layout, 0x6001u, 4u, &dropped_field, &retained_dead);
    int field_matches = !status && retained_live
        && retained_field >= 0x7000u
        && retained_field - 0x7000u <= sizeof live_field_output - 4u
        && live_field_output[retained_field - 0x7000u] == 0x78u
        && live_field_output[retained_field - 0x7000u + 1u] == 0x56u
        && live_field_output[retained_field - 0x7000u + 2u] == 0x34u
        && live_field_output[retained_field - 0x7000u + 3u] == 0x12u;
    free(workspace);
    if (status || !field_matches || retained_dead
            || population.direct_frame_blocks == 0u) {
        fprintf(stderr,
                "native layout: RED (live field status=%d direct=%u "
                "field=%llx/%d dropped=%llx/%d)\n",
                status, population.direct_frame_blocks,
                (unsigned long long)retained_field, retained_live,
                (unsigned long long)dropped_field, retained_dead);
        return 1;
    }
    printf("native layout: green (unreachable suffix removed; affine 9 -> 5 bytes; ALU 8 -> 5 bytes; insert 4 -> 3 bytes; rel8 cascade=2; direct results=42/42/42/42)\n");
    return 0;
}

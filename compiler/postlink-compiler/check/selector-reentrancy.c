#define _XOPEN_SOURCE 700
#include "internal/x86-selection.h"

#include <pthread.h>
#include <stdio.h>
#include <string.h>

enum { THREADS = 4, ITERATIONS = 256, ARENA_BYTES = 256 * 1024 };
typedef struct {
    pl_u8 bytes[11];
    pl_u8 formation[2][ARENA_BYTES];
    pl_u8 selection[2][ARENA_BYTES];
    pl_x86_frontend frontend;
    pl_x86_block block;
    pl_x86_native_selection expected;
    pl_u8 output[256];
    pl_u32 written;
    int status;
} job;

static job jobs[THREADS];
static pthread_barrier_t start;

static int select_job(job *item, pl_x86_native_selection *chosen,
                      pl_u8 *output, pl_u32 *written)
{
    pl_x86_block_workspace arena = {
        item->selection[0], item->selection[1], ARENA_BYTES, 32u,
    };
    return pl_x86_select_write(&item->frontend, &arena, &item->block,
                              output, 256u, written, chosen);
}

static void *repeat_selection(void *argument)
{
    job *item = argument;
    int status = pthread_barrier_wait(&start);
    if (status && status != PTHREAD_BARRIER_SERIAL_THREAD) {
        item->status = status;
        return 0;
    }
    for (unsigned iteration = 0; iteration < ITERATIONS; ++iteration) {
        pl_x86_native_selection chosen;
        pl_u8 output[256];
        pl_u32 written = 0;
        item->status = select_job(item, &chosen, output, &written);
        if (item->status) break;
        if (written != item->written
                || chosen.address_memo
                || memcmp(output, item->output, written)
                || chosen.fixup_count != item->expected.fixup_count
                || memcmp(chosen.fixups, item->expected.fixups,
                          chosen.fixup_count * sizeof chosen.fixups[0])) {
            item->status = 1;
            break;
        }
    }
    return 0;
}

int main(void)
{
    /* Equal virtual coordinates do not imply equal source identity. Each
     * caller owns a distinct image and arenas; the RIP displacement differs.
     * Selection must have neither a shared epoch nor a shared mutable memo. */
    pl_x86_map maps[THREADS];
    pl_x86_image images[THREADS];
    pthread_t threads[THREADS];
    for (unsigned index = 0; index < THREADS; ++index) {
        job *item = &jobs[index];
        const pl_u8 code[11] = {
            0x48, 0x8d, 0x05, 0x7f, 0, 0, 0, /* lea rax,[rip+127] */
            0x48, 0x31, 0xc8, 0xc3,          /* xor rax,rcx; ret */
        };
        memcpy(item->bytes, code, sizeof code);
        item->bytes[3] = (pl_u8)(0x40u + index);
        maps[index] = (pl_x86_map){ item->bytes, 0x1000u,
            sizeof item->bytes, sizeof item->bytes,
            PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u };
        images[index] = (pl_x86_image){ &maps[index], 1u, 0u, 0x1000u };
        pl_x86_block_workspace arena = {
            item->formation[0], item->formation[1], ARENA_BYTES, 32u,
        };
        item->status = pl_x86_frontend_open(&images[index], &item->frontend);
        if (!item->status)
            item->status = pl_x86_block_lower(&item->frontend, 0x1000u,
                                             &arena, &item->block);
        if (!item->status)
            item->status = select_job(item, &item->expected, item->output,
                                      &item->written);
        if (!item->status && item->expected.address_memo) item->status = 1;
        if (item->status) {
            fprintf(stderr, "selector serial setup %u: %d\n", index, item->status);
            return 1;
        }
    }
    if (pthread_barrier_init(&start, 0, THREADS)) return 1;
    pthread_attr_t attributes;
    if (pthread_attr_init(&attributes)
            || pthread_attr_setstacksize(&attributes, 2u * 1024u * 1024u))
        return 1;
    for (unsigned index = 0; index < THREADS; ++index)
        if (pthread_create(&threads[index], &attributes,
                           repeat_selection, &jobs[index]))
            return 1;
    if (pthread_attr_destroy(&attributes)) return 1;
    int failed = 0;
    for (unsigned index = 0; index < THREADS; ++index) {
        if (pthread_join(threads[index], 0) || jobs[index].status) failed = 1;
    }
    if (pthread_barrier_destroy(&start)) failed = 1;
    if (failed) {
        fputs("selector concurrent result differs from serial result\n", stderr);
        return 1;
    }
    puts("selector: 4 independent images, 1024 concurrent selections match serial output");
    return 0;
}

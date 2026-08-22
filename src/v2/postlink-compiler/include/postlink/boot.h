/* Prepared x86-64 Linux boot-state reader.
 *
 * A boot cache contains one canonical architectural cut followed by a sparse
 * physical-memory bundle.  It is a compiler input: the emitted executable
 * root embeds the CPU cut and names each nonzero physical page directly, so
 * no browser-side state or instruction decoder is needed at run time.
 */

#ifndef POSTLINK_BOOT_H
#define POSTLINK_BOOT_H

#include <postlink/executable.h>
#include <postlink/physical.h>

#define PL_X86_STATE_MAGIC "x86-state-v1\n"

#define PL_ERROR_BOOT       (-67)
#define PL_ERROR_BOOT_RANGE (-68)
#define PL_ERROR_BOOT_STATE (-69)

typedef struct {
    pl_executable_state state;
    pl_physical_bundle memory;
    pl_u64 cpu_offset;
    pl_u64 cpu_bytes;
    pl_u64 memory_offset;
    pl_u64 memory_bytes;
} pl_boot_cache;

int pl_boot_cache_open(const pl_u8 *bytes, pl_u64 length,
                       pl_boot_cache *out);

#endif /* POSTLINK_BOOT_H */

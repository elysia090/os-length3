/* The post-link machine container.  See src/machine.c. */

#ifndef POSTLINK_MACHINE_H
#define POSTLINK_MACHINE_H

#include <postlink/format.h>

/* The container is
 *
 *     magic                       "x86-native-machine-v5\n"
 *     u32 header_bytes
 *     header                      compact ASCII JSON, sorted keys
 *     ... zero padding ...
 *     memory region               64 KiB-aligned
 *     descriptor region           64 KiB-aligned
 *     execution region            64 KiB-aligned
 *
 * The three regions are independently aligned so a delivery can map each one
 * without materializing the others; the header's region directory holds their
 * absolute offsets, which is why the writer iterates it to a fixed point.
 */

typedef struct {
    pl_u64 offset;
    pl_u64 length;
} pl_region;

typedef struct {
    pl_u32 schema;          /* 1..5 */
    pl_u32 header_bytes;
    pl_u32 header_offset;   /* into the payload */
    pl_u32 page_bytes;
    pl_region memory;
    pl_region descriptors;
    pl_region execution;
} pl_machine;

#define PL_ERROR_CONTAINER (-10)
#define PL_ERROR_REGION    (-11)

/* Parse and validate the container framing.  Regions must be aligned, ordered,
 * non-overlapping and inside `bytes`.  The header JSON itself is left in place;
 * `header_offset`/`header_bytes` name it. */
int pl_machine_parse(const pl_u8 *payload, pl_u64 bytes, pl_machine *out);

/* Read one unsigned integer field from the compact header JSON.  `path` is a
 * dotted key path, e.g. "memory.length" or "regions.page_bytes".  Returns 0 on
 * success.  Only the flat integer fields the container framing needs are
 * supported; this is not a general JSON reader. */
int pl_machine_header_u64(const pl_u8 *header, pl_u32 bytes,
                          const char *path, pl_u64 *value);

#endif /* POSTLINK_MACHINE_H */

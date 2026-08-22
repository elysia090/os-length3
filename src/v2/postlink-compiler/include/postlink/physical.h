/* Canonical sparse physical-memory bundle reader.
 *
 * The reader owns no storage and performs no allocation.  It validates the
 * quotient directory and the range directory in place, then exposes only two
 * operations needed by a post-link compiler: iterate nonzero logical spans
 * and decode one unique span.  Compression is supplied by the command-line
 * driver so the freestanding library does not acquire a zlib dependency.
 */

#ifndef POSTLINK_PHYSICAL_H
#define POSTLINK_PHYSICAL_H

#include <postlink/sha256.h>

#define PL_PHYSICAL_MANIFEST_MAGIC "PGF1"
#define PL_PHYSICAL_BUNDLE_MAGIC "PGB1"
#define PL_PHYSICAL_MANIFEST_VERSION 1u
#define PL_PHYSICAL_BUNDLE_VERSION 4u
#define PL_PHYSICAL_MANIFEST_HEADER_BYTES 104u
#define PL_PHYSICAL_BUNDLE_HEADER_BYTES 20u
#define PL_PHYSICAL_BUNDLE_RECORD_BYTES 46u

#define PL_ERROR_PHYSICAL          (-62)
#define PL_ERROR_PHYSICAL_RANGE    (-63)
#define PL_ERROR_PHYSICAL_CODEC    (-64)
#define PL_ERROR_PHYSICAL_DIGEST   (-65)
#define PL_ERROR_PHYSICAL_ABSENT   (-66)

typedef struct {
    const pl_u8 *bytes;
    pl_u64 bytes_count;
    pl_u8 object_digest[PL_SHA256_BYTES];
    pl_u8 shard_root[PL_SHA256_BYTES];
    pl_u64 generation;
    pl_u64 length;
    pl_u32 page_bytes;
    pl_u32 page_count;
    pl_u32 unique_pages;
    pl_u32 nonzero_pages;
    pl_u16 data_shards;
    pl_u16 parity_shards;
    const pl_u8 *directory;
    pl_u32 directory_bytes;
    const pl_u8 *records;
    pl_u32 record_count;
    const pl_u8 *payloads;
    pl_u64 payload_bytes;
} pl_physical_bundle;

typedef struct {
    const pl_physical_bundle *bundle;
    pl_u32 cursor;
    pl_u32 ordinal;
    pl_u32 prior_page;
} pl_physical_cursor;

typedef struct {
    pl_u32 group;
    pl_u16 slot;
    const pl_u8 *payload;
    pl_u32 payload_bytes;
    pl_u8 digest[PL_SHA256_BYTES];
} pl_physical_record;

/* Return zero only when `target` contains exactly `target_bytes` bytes. */
typedef int (*pl_physical_inflate)(
    void *context, const pl_u8 *source, pl_u32 source_bytes,
    pl_u8 *target, pl_u32 target_bytes);

int pl_physical_bundle_open(const pl_u8 *bytes, pl_u64 length,
                            pl_physical_bundle *out);

void pl_physical_cursor_open(const pl_physical_bundle *bundle,
                             pl_physical_cursor *cursor);

/* Return 1 and the next nonzero logical page, 0 at the canonical end, or a
 * negative PL_ERROR_PHYSICAL value. */
int pl_physical_cursor_next(pl_physical_cursor *cursor,
                            pl_u32 *logical_page, pl_u32 *unique_rank);

int pl_physical_bundle_record(const pl_physical_bundle *bundle,
                              pl_u32 unique_rank,
                              pl_physical_record *out);

int pl_physical_bundle_decode(const pl_physical_bundle *bundle,
                              pl_u32 unique_rank,
                              pl_u8 *target, pl_u32 target_bytes,
                              pl_physical_inflate inflate, void *context);

#endif /* POSTLINK_PHYSICAL_H */

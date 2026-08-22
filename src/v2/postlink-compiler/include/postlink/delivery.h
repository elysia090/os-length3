/* Untrusted location hints for content-addressed compiler objects. */

#ifndef POSTLINK_DELIVERY_H
#define POSTLINK_DELIVERY_H

#include <postlink/sha256.h>

#define PL_DELIVERY_MAGIC "postlink-object-locator-v1\n"
#define PL_DELIVERY_MAGIC_BYTES 32u
#define PL_DELIVERY_VERSION 1u
#define PL_DELIVERY_HEADER_BYTES 64u
#define PL_DELIVERY_ROW_BYTES 48u

#define PL_ERROR_DELIVERY       (-59)
#define PL_ERROR_DELIVERY_RANGE (-60)
#define PL_ERROR_DELIVERY_ABSENT (-61)

typedef struct {
    pl_u8 digest[PL_SHA256_BYTES];
    pl_u64 offset;
    pl_u32 bytes;
} pl_delivery_locator;

typedef struct {
    const pl_u8 *bytes;
    pl_u32 length;
    pl_u32 count;
    pl_u64 pack_bytes;
} pl_delivery_index;

/* Rows are sorted by the complete digest.  Their offsets are deliberately
 * not part of object identity: a storage tier may repack them freely, while
 * the selected payload is accepted only after its digest and extent agree. */
int pl_delivery_index_write(
    const pl_delivery_locator *locators, pl_u32 count, pl_u64 pack_bytes,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written);
int pl_delivery_index_open(
    const pl_u8 *bytes, pl_u64 length, pl_u64 pack_bytes,
    pl_delivery_index *out);
int pl_delivery_index_find(
    const pl_delivery_index *index,
    const pl_u8 digest[PL_SHA256_BYTES], pl_delivery_locator *out);
int pl_delivery_index_find_rank(
    const pl_delivery_index *index,
    const pl_u8 digest[PL_SHA256_BYTES], pl_u32 *rank,
    pl_delivery_locator *out);
int pl_delivery_payload_validate(
    const pl_delivery_locator *locator,
    const pl_u8 *payload, pl_u64 bytes);

#endif /* POSTLINK_DELIVERY_H */

/* Untrusted location hints for content-addressed compiler objects. */

#ifndef STORAGE_DELIVERY_H
#define STORAGE_DELIVERY_H

#include <support/sha256.h>

#define PL_DELIVERY_MAGIC "postlink-object-locator-v1\n"
#define PL_DELIVERY_MAGIC_BYTES 32u
#define PL_DELIVERY_VERSION 1u
#define PL_DELIVERY_HEADER_BYTES 64u
#define PL_DELIVERY_ROW_BYTES 48u

/* Replaceable, page-bounded locator projection.  The executable names
 * canonical objects only by complete SHA-256 digest and exact extent.  This
 * directory maps that identity to an untrusted pack coordinate without
 * requiring the complete locator set to become resident.  Every branch binds
 * the complete first/last digest of each child; truncating the key would make
 * a prefix collision an ambiguous physical spelling. */
#define PL_DELIVERY_DIRECTORY_MAGIC "postlink-delivery-directory-v2\n"
#define PL_DELIVERY_NODE_MAGIC "postlink-delivery-node-v2\n"
#define PL_DELIVERY_DIRECTORY_VERSION 2u
#define PL_DELIVERY_DIRECTORY_BYTES 192u
#define PL_DELIVERY_NODE_BYTES 4096u
#define PL_DELIVERY_NODE_HEADER_BYTES 128u
#define PL_DELIVERY_REF_BYTES 128u
#define PL_DELIVERY_LEAF_ROW_BYTES PL_DELIVERY_ROW_BYTES
#define PL_DELIVERY_BRANCH_ROW_BYTES PL_DELIVERY_REF_BYTES
#define PL_DELIVERY_LEAF_CAPACITY                                  \
    ((PL_DELIVERY_NODE_BYTES - PL_DELIVERY_NODE_HEADER_BYTES)      \
     / PL_DELIVERY_LEAF_ROW_BYTES)
#define PL_DELIVERY_BRANCH_CAPACITY                                \
    ((PL_DELIVERY_NODE_BYTES - PL_DELIVERY_NODE_HEADER_BYTES)      \
     / PL_DELIVERY_BRANCH_ROW_BYTES)
#define PL_DELIVERY_MAX_LEVEL 15u

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

typedef struct {
    pl_u8 digest[PL_SHA256_BYTES];
    pl_u64 offset;
    pl_u32 node_bytes;
    pl_u32 level;
    pl_u64 rows;
    pl_u8 first[PL_SHA256_BYTES];
    pl_u8 last[PL_SHA256_BYTES];
} pl_delivery_ref;

typedef struct {
    const pl_u8 *bytes;
    pl_u32 length;
    pl_u32 level;
    pl_u32 row_count;
    pl_u32 row_bytes;
    pl_u64 rows;
    const pl_u8 *first;
    const pl_u8 *last;
} pl_delivery_node;

typedef struct {
    pl_u64 pack_bytes;
    pl_delivery_ref root;
} pl_delivery_directory;

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

int pl_delivery_ref_validate(const pl_delivery_ref *ref, pl_u64 pack_bytes);
int pl_delivery_ref_read(
    const pl_u8 bytes[PL_DELIVERY_REF_BYTES], pl_u64 pack_bytes,
    pl_delivery_ref *out);
int pl_delivery_ref_write(
    const pl_delivery_ref *ref, pl_u64 pack_bytes,
    pl_u8 bytes[PL_DELIVERY_REF_BYTES]);
int pl_delivery_leaf_write(
    const pl_delivery_locator *locators, pl_u32 count,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written);
int pl_delivery_branch_write(
    const pl_delivery_ref *children, pl_u32 count, pl_u64 pack_bytes,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written);
int pl_delivery_ref_from_node(
    const pl_u8 *bytes, pl_u32 length, pl_u64 offset, pl_u64 pack_bytes,
    pl_delivery_ref *out);
int pl_delivery_directory_write(
    const pl_delivery_ref *root, pl_u64 pack_bytes,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written);
int pl_delivery_directory_open(
    const pl_u8 *bytes, pl_u64 length, pl_delivery_directory *out);
int pl_delivery_node_open(
    const pl_delivery_directory *directory,
    const pl_delivery_ref *expected,
    const pl_u8 *bytes, pl_u32 length, pl_delivery_node *out);
int pl_delivery_node_select(
    const pl_delivery_directory *directory, const pl_delivery_node *node,
    const pl_u8 digest[PL_SHA256_BYTES], pl_delivery_ref *out);
int pl_delivery_node_find(
    const pl_delivery_directory *directory, const pl_delivery_node *node,
    const pl_u8 digest[PL_SHA256_BYTES], pl_delivery_locator *out);

#endif /* STORAGE_DELIVERY_H */

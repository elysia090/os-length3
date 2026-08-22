/* Content-addressed sorted index whose opened state is one selected path.
 *
 * Leaves contain caller-defined fixed rows beginning with a 128-bit key.
 * Branches contain only authenticated child references.  Every node is at
 * most one physical 4 KiB page, so lookup needs O(log N) fetched/resident
 * pages without materializing the complete directory.
 */

#ifndef POSTLINK_INDEX_H
#define POSTLINK_INDEX_H

#include <postlink/sha256.h>

#define PL_INDEX_MAGIC "postlink-index-v1\n"
#define PL_INDEX_MAGIC_BYTES 32u
#define PL_INDEX_VERSION 1u
#define PL_INDEX_HEADER_BYTES 96u
#define PL_INDEX_NODE_BYTES 4096u
#define PL_INDEX_REF_BYTES 88u
#define PL_INDEX_KEY_BYTES 16u
#define PL_INDEX_MAX_LEVEL 15u

#define PL_ERROR_INDEX          (-33)
#define PL_ERROR_INDEX_RANGE    (-34)
#define PL_ERROR_INDEX_DIGEST   (-35)
#define PL_ERROR_INDEX_ABSENT   (-36)

typedef struct {
    pl_u64 major;
    pl_u64 minor;
} pl_index_key;

/* This is both the fixed root coordinate stored by an executable and the
 * branch-row value.  The key bounds make a child self-contained: opening it
 * proves that its authenticated header names exactly the promised interval. */
typedef struct {
    pl_u8 digest[PL_SHA256_BYTES];
    pl_u64 rows;
    pl_u32 node_bytes;
    pl_u32 level;
    pl_u32 leaf_row_bytes;
    pl_u32 reserved;
    pl_index_key first;
    pl_index_key last;
} pl_index_ref;

typedef struct {
    const pl_u8 *bytes;
    pl_u32 length;
    pl_u32 level;
    pl_u32 leaf_row_bytes;
    pl_u32 row_bytes;
    pl_u32 row_count;
    pl_index_key first;
    pl_index_key last;
} pl_index_node;

int pl_index_key_compare(pl_index_key left, pl_index_key right);
int pl_index_ref_validate(const pl_index_ref *ref);
int pl_index_ref_read(const pl_u8 row[PL_INDEX_REF_BYTES],
                      pl_index_ref *out);
int pl_index_ref_write(const pl_index_ref *ref,
                       pl_u8 row[PL_INDEX_REF_BYTES]);

/* Writers are deterministic and reject unsorted, overlapping or oversized
 * rows.  `pl_index_ref_from_node` hashes and reopens the node, producing the
 * only reference spelling accepted by a parent or executable root. */
int pl_index_leaf_write(const pl_u8 *rows, pl_u32 row_bytes,
                        pl_u32 row_count, pl_u8 *target, pl_u32 capacity,
                        pl_u32 *written);
int pl_index_branch_write(const pl_index_ref *children, pl_u32 child_count,
                          pl_u8 *target, pl_u32 capacity, pl_u32 *written);
int pl_index_ref_from_node(const pl_u8 *bytes, pl_u32 length,
                           pl_index_ref *out);

/* Bottom-up canonical tree writer.  `references` holds only the current
 * frontier (at most ceil(row_count / leaf_capacity) entries) and is compacted
 * in place at each level.  `publish` receives each independently addressed
 * node after its digest/reference has been proved; the node buffer is reused
 * immediately after the callback returns. */
typedef int (*pl_index_publish)(void *context,
                                const pl_u8 digest[PL_SHA256_BYTES],
                                const pl_u8 *bytes, pl_u32 length);
int pl_index_build(const pl_u8 *rows, pl_u32 row_bytes, pl_u32 row_count,
                   pl_index_ref *references, pl_u32 reference_capacity,
                   pl_u8 node[PL_INDEX_NODE_BYTES],
                   pl_index_publish publish, void *context,
                   pl_index_ref *root);

/* Opening recomputes SHA-256 in C and checks all canonical structure. */
int pl_index_node_open(const pl_index_ref *expected, const pl_u8 *bytes,
                       pl_u32 length, pl_index_node *out);

/* A branch selects one child reference.  A leaf returns the exact row. */
int pl_index_select_child(const pl_index_node *node, pl_index_key key,
                          pl_index_ref *out);
int pl_index_find_row(const pl_index_node *node, pl_index_key key,
                      const pl_u8 **row);

/* Ordered range directories also need predecessor lookup: a module row is
 * keyed by its first function, while any function inside that dense range
 * must select the same module without duplicating one row per function. */
int pl_index_select_floor_child(const pl_index_node *node, pl_index_key key,
                                pl_index_ref *out);
int pl_index_find_floor(const pl_index_node *node, pl_index_key key,
                        const pl_u8 **row);

#endif /* POSTLINK_INDEX_H */

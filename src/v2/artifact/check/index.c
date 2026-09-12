#include <artifact/index.h>
#include <support/checked.h>

#include <stdio.h>

enum { ROW_BYTES = 32u, ROWS = 300u, MAX_NODES = 16u };

typedef struct {
    pl_u8 bytes[MAX_NODES][PL_INDEX_NODE_BYTES];
    pl_u8 digest[MAX_NODES][PL_SHA256_BYTES];
    pl_u32 length[MAX_NODES];
    pl_u32 nodes;
    pl_u32 duplicates;
} node_store;

static int equal(const pl_u8 *left, const pl_u8 *right, pl_u32 bytes)
{
    pl_u32 difference = 0u;
    for (pl_u32 index = 0u; index < bytes; ++index)
        difference |= (pl_u32)(left[index] ^ right[index]);
    return difference == 0u;
}

static int publish(void *opaque,
                   const pl_u8 digest[PL_SHA256_BYTES],
                   const pl_u8 *bytes, pl_u32 length)
{
    node_store *store = opaque;
    for (pl_u32 node = 0u; node < store->nodes; ++node) {
        if (!equal(store->digest[node], digest, PL_SHA256_BYTES)) continue;
        if (store->length[node] != length
                || !equal(store->bytes[node], bytes, length))
            return PL_ERROR_INDEX_DIGEST;
        ++store->duplicates;
        return 0;
    }
    if (store->nodes >= MAX_NODES || length > PL_INDEX_NODE_BYTES)
        return PL_ERROR_INDEX_RANGE;
    pl_u32 node = store->nodes++;
    store->length[node] = length;
    for (pl_u32 index = 0u; index < PL_SHA256_BYTES; ++index)
        store->digest[node][index] = digest[index];
    for (pl_u32 index = 0u; index < length; ++index)
        store->bytes[node][index] = bytes[index];
    return 0;
}

static int open_node(const node_store *store, const pl_index_ref *reference,
                     pl_index_node *out)
{
    for (pl_u32 node = 0u; node < store->nodes; ++node)
        if (store->length[node] == reference->node_bytes
                && equal(store->digest[node], reference->digest,
                         PL_SHA256_BYTES))
            return pl_index_node_open(
                reference, store->bytes[node], store->length[node], out);
    return PL_ERROR_INDEX_ABSENT;
}

static int reopen_rows(const node_store *store, const pl_index_ref *root,
                       const pl_u8 *rows)
{
    for (pl_u32 index = 0u; index < ROWS; ++index) {
        pl_index_key key = { 0u, index };
        pl_index_ref current = *root;
        pl_index_node node;
        int status = open_node(store, &current, &node);
        while (!status && node.level) {
            status = pl_index_select_child(&node, key, &current);
            if (!status) status = open_node(store, &current, &node);
        }
        const pl_u8 *row = 0;
        if (!status) status = pl_index_find_row(&node, key, &row);
        if (status || !equal(
                row, rows + (size_t)index * ROW_BYTES, ROW_BYTES))
            return status ? status : PL_ERROR_INDEX;
    }
    return 0;
}

static int same_ref(const pl_index_ref *left, const pl_index_ref *right)
{
    pl_u8 a[PL_INDEX_REF_BYTES], b[PL_INDEX_REF_BYTES];
    return !pl_index_ref_write(left, a) && !pl_index_ref_write(right, b)
        && equal(a, b, sizeof(a));
}

int main(void)
{
    pl_u8 rows[ROWS][ROW_BYTES];
    for (pl_u32 row = 0u; row < ROWS; ++row) {
        for (pl_u32 byte = 0u; byte < ROW_BYTES; ++byte)
            rows[row][byte] = 0u;
        pl_write_u64(rows[row], 0u);
        pl_write_u64(rows[row] + 8u, row);
        pl_write_u64(rows[row] + 16u, (pl_u64)row * 17u + 3u);
        pl_write_u64(rows[row] + 24u, 32u);
    }
    node_store store = { 0 };
    pl_index_ref references[8];
    pl_u8 node[PL_INDEX_NODE_BYTES];
    pl_index_ref first, second, changed;
    int status = pl_index_build(
        rows[0], ROW_BYTES, ROWS, references, 8u,
        node, publish, &store, &first);
    pl_u32 first_nodes = store.nodes;
    if (!status) status = reopen_rows(&store, &first, rows[0]);
    if (!status)
        status = pl_index_build(
            rows[0], ROW_BYTES, ROWS, references, 8u,
            node, publish, &store, &second);
    if (!status && (!same_ref(&first, &second)
            || store.nodes != first_nodes
            || store.duplicates != first_nodes))
        status = PL_ERROR_INDEX;

    /* One changed leaf creates exactly that leaf and its root path.  Unchanged
     * subtrees keep their full-byte-proved content identities. */
    rows[200][16u] ^= 1u;
    pl_u32 before_changed = store.nodes;
    pl_u32 before_duplicates = store.duplicates;
    if (!status)
        status = pl_index_build(
            rows[0], ROW_BYTES, ROWS, references, 8u,
            node, publish, &store, &changed);
    if (!status && (same_ref(&first, &changed)
            || store.nodes - before_changed != 2u
            || store.duplicates - before_duplicates != first_nodes - 2u))
        status = PL_ERROR_INDEX;

    if (status) {
        fprintf(stderr, "canonical directory DAG: RED (%d)\n", status);
        return 1;
    }
    printf("canonical directory DAG: green "
           "(%u rows -> %u nodes; one change -> 2 new path nodes)\n",
           ROWS, first_nodes);
    return 0;
}

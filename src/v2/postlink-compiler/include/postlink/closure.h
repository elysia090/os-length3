/* Total linked-x86 closure projected into the physical page entry map. */

#ifndef POSTLINK_CLOSURE_H
#define POSTLINK_CLOSURE_H

#include <postlink/block.h>
#include <postlink/entrymap.h>

#define PL_ERROR_CLOSURE          (-43)
#define PL_ERROR_CLOSURE_CAPACITY (-44)

typedef struct {
    pl_u64 virtual_page;
    pl_u32 generation;
    pl_u32 entry_page_rank;
} pl_closure_page;

typedef struct {
    pl_u64 pages;
    pl_u64 coordinates;
    pl_u64 mapped_coordinates;
    pl_u64 fault_coordinates;
    pl_u64 precise_cuts;
    pl_u64 direct_edges;
    pl_u64 direct_edges_in_image;
    pl_u64 direct_edges_outside_image;
    pl_u64 indirect_edges;
} pl_closure_report;

/* Return the final quotient function rank for one total source coordinate.
 * The callback is compiler-side: it lowers/normalizes the instruction or its
 * architectural fault, and never runs in vm.wasm's dynamic dispatch path. */
typedef int (*pl_closure_rank)(const pl_x86_instruction *instruction,
                               void *context, pl_u32 *function_rank);

int pl_closure_page_count(const pl_x86_image *image, pl_u32 *count);

/* Build one complete 4096-coordinate row for every executable page, including
 * architecturally correct fetch-fault ranks in holes and edge padding.  Equal
 * 256-coordinate rows are interned by the supplied entry-map builder. */
int pl_closure_build(const pl_x86_image *image, pl_closure_rank rank,
                     void *context, pl_entry_map_builder *entry_builder,
                     pl_closure_page *pages, pl_u32 page_capacity,
                     pl_closure_report *report);

typedef struct {
    pl_u64 successor_delta[2];
    pl_u32 successor_count;
    pl_u32 dynamic_target;
} pl_closure_transfer_edge;

typedef struct {
    pl_u32 *page_rows[2];
    pl_u32 *tail_rows[2];
    pl_u32 *tail_hash[2];
    pl_u32 page_capacity;
    pl_u32 tail_capacity;
    pl_u32 tail_hash_slots;
    pl_closure_page *pages;
    pl_closure_transfer_edge *transfer_edges;
    pl_u32 transfer_edge_capacity;
    pl_u64 *representatives;
    pl_u32 class_capacity;
    pl_u32 coordinate_capacity;
    pl_u32 predecessor_capacity;
    pl_u32 *reverse_offsets; /* coordinate_capacity + 1 */
    pl_u32 *predecessors;    /* (source << 1) | ordered arm */
    pl_u32 *classes;         /* one dense build-side word per coordinate */
    pl_u32 *order;           /* class-contiguous coordinate ranks */
    pl_u32 *frontier;        /* source ranks touched by one splitter */
    pl_u32 *positions;       /* inverse permutation of order */
    pl_u32 *class_starts;
    pl_u32 *class_sizes;
    pl_u32 *class_hits;
    pl_u32 *touched_classes;
    pl_u32 *split_queue;     /* 2 * class_capacity (class, arm) pairs */
    pl_u8 *queued_arms;      /* two bits per class */
} pl_closure_partition_workspace;

typedef struct {
    pl_u32 classes;
    pl_u32 splits;
    pl_u32 splitters;
    pl_u32 maximum_frontier;
    pl_u64 coordinates;
    pl_u64 predecessor_edges;
    pl_u64 splitter_states;
    pl_u64 frontier_states;
} pl_closure_partition_report;

/* Refine total executable coordinates to the least stable partition of
 * (normalized transfer, ordered successor classes).  Two physical entry-map
 * buffers alternate.  A build-only reverse-edge CSR drives exact Hopcroft
 * splitting, so work is proportional to changed predecessor frontiers rather
 * than `coordinates * graph diameter`. `representatives[class]` names the
 * source coordinate used to emit the final direct function. */
int pl_closure_partition(
    const pl_x86_image *image, pl_x86_block_builder *blocks,
    const pl_closure_partition_workspace *workspace,
    pl_entry_map *entry_map, pl_closure_report *closure,
    pl_closure_partition_report *partition);

/* Resolve one source coordinate through the final total page projection. */
int pl_closure_lookup(const pl_closure_page *pages, pl_u32 page_count,
                      const pl_entry_map *entry_map, pl_u64 coordinate,
                      pl_u32 *function_rank);

#endif /* POSTLINK_CLOSURE_H */

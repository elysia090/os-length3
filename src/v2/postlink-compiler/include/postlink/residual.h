/* Succinct residual-state graph for successor-free compiled kernels. */

#ifndef POSTLINK_RESIDUAL_H
#define POSTLINK_RESIDUAL_H

#include <postlink/format.h>

#define PL_ERROR_RESIDUAL          (-53)
#define PL_ERROR_RESIDUAL_CAPACITY (-54)
#define PL_RESIDUAL_RESOLVE 0xffffffffu

#define PL_RESIDUAL_PAGE_BYTES 4096u
#define PL_RESIDUAL_STATE_PAGE_STATES 1024u
#define PL_RESIDUAL_STATE_PAGE_WORDS 16u
#define PL_RESIDUAL_STATE_PAGE_HEADER 64u
#define PL_RESIDUAL_STATE_PAGE_KERNELS 64u
#define PL_RESIDUAL_STATE_PAGE_ZERO_BITS 3136u
#define PL_RESIDUAL_STATE_PAGE_TWO_BITS 3264u
#define PL_RESIDUAL_STATE_PAGE_USED 3392u
#define PL_RESIDUAL_EDGE_PAGE_EDGES 512u
#define PL_RESIDUAL_EDGE_PAGE_HEADER 64u
#define PL_RESIDUAL_EDGE_PAGE_NEXT 64u
#define PL_RESIDUAL_EDGE_PAGE_DELTA 1600u
#define PL_RESIDUAL_EDGE_PAGE_USED 3648u

/* States have zero, one, or two ordered static edges.  Two bitplanes encode
 * the degree without a CSR offset per state:
 *
 *   degree(r)    = 1 + two[r] - zero[r]
 *   edge_base(r) = r + rank(two,r) - rank(zero,r)
 *
 * where rank is the exclusive prefix population count.  Kernel and edge
 * columns can therefore be paged independently, and only the selected branch
 * edge is touched at runtime. */
typedef struct {
    const pl_u32 *kernels;
    const pl_u64 *zero_bits;
    const pl_u64 *two_bits;
    const pl_u32 *zero_prefix;
    const pl_u32 *two_prefix;
    /* edge_next is either another residual rank or PL_RESIDUAL_RESOLVE for a
     * static target outside the linked image.  The latter still applies its
     * RIP delta before entering the authenticated coordinate projection. */
    const pl_u32 *edge_next;
    const pl_i32 *edge_rip_delta;
    pl_u32 state_count;
    pl_u32 edge_count;
    pl_u32 kernel_count;
    pl_u32 word_count;
} pl_residual_graph;

typedef struct {
    pl_u32 *kernels;
    pl_u64 *zero_bits;
    pl_u64 *two_bits;
    pl_u32 *zero_prefix;
    pl_u32 *two_prefix;
    pl_u32 *edge_next;
    pl_i32 *edge_rip_delta;
    pl_u32 state_capacity;
    pl_u32 edge_capacity;
    pl_u32 word_capacity;
    pl_u32 state_count;
    pl_u32 edge_count;
} pl_residual_builder;

/* Validation is linear in the complete graph and must occur once per output,
 * not once per delivery page.  This handle records that proof while each
 * subsequent write touches only its selected page. */
typedef struct {
    const pl_residual_graph *graph;
} pl_residual_page_writer;

int pl_residual_builder_open(pl_residual_builder *builder,
                             pl_u32 *kernels, pl_u32 state_capacity,
                             pl_u64 *zero_bits, pl_u64 *two_bits,
                             pl_u32 *zero_prefix, pl_u32 *two_prefix,
                             pl_u32 word_capacity,
                             pl_u32 *edge_next, pl_i32 *edge_rip_delta,
                             pl_u32 edge_capacity);

int pl_residual_add(pl_residual_builder *builder, pl_u32 kernel,
                    pl_u32 degree, const pl_u32 next[2],
                    const pl_i32 rip_delta[2], pl_u32 *rank);

int pl_residual_finish(pl_residual_builder *builder, pl_u32 kernel_count,
                       pl_residual_graph *out);

int pl_residual_validate(const pl_residual_graph *graph);
int pl_residual_page_writer_open(
    pl_residual_page_writer *writer, const pl_residual_graph *graph);

int pl_residual_state(const pl_residual_graph *graph, pl_u32 state,
                      pl_u32 *kernel, pl_u32 *degree, pl_u32 *edge_base);

int pl_residual_edge(const pl_residual_graph *graph, pl_u32 state,
                     pl_u32 arm, pl_u32 *next, pl_i32 *rip_delta);

/* Canonical independently authenticated delivery pages.  Unused fields and
 * the tail of the final page are zero; readers reject a second spelling. */
int pl_residual_state_page_write(
    const pl_residual_graph *graph, pl_u32 page_rank,
    pl_u8 target[PL_RESIDUAL_PAGE_BYTES]);
int pl_residual_state_page_writer_write(
    const pl_residual_page_writer *writer, pl_u32 page_rank,
    pl_u8 target[PL_RESIDUAL_PAGE_BYTES]);
int pl_residual_state_page_open(
    const pl_u8 page[PL_RESIDUAL_PAGE_BYTES], pl_u32 page_rank,
    pl_u32 state_count, pl_u32 edge_count, pl_u32 kernel_count);
int pl_residual_state_page_kernel(
    const pl_u8 page[PL_RESIDUAL_PAGE_BYTES], pl_u32 local,
    pl_u32 *kernel);
int pl_residual_state_page_edge_base(
    const pl_u8 page[PL_RESIDUAL_PAGE_BYTES], pl_u32 local,
    pl_u32 *degree, pl_u32 *edge_base);

int pl_residual_edge_page_write(
    const pl_residual_graph *graph, pl_u32 page_rank,
    pl_u8 target[PL_RESIDUAL_PAGE_BYTES]);
int pl_residual_edge_page_writer_write(
    const pl_residual_page_writer *writer, pl_u32 page_rank,
    pl_u8 target[PL_RESIDUAL_PAGE_BYTES]);
int pl_residual_edge_page_open(
    const pl_u8 page[PL_RESIDUAL_PAGE_BYTES], pl_u32 page_rank,
    pl_u32 state_count, pl_u32 edge_count);
int pl_residual_edge_page_get(
    const pl_u8 page[PL_RESIDUAL_PAGE_BYTES], pl_u32 local,
    pl_u32 *next, pl_i32 *rip_delta);

#endif /* POSTLINK_RESIDUAL_H */

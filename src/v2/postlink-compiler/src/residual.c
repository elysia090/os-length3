/* Succinct residual-state graph.  See include/postlink/residual.h. */

#include <postlink/residual.h>

static const pl_u8 STATE_MAGIC[8] = {
    'R', 'S', 'T', 'A', 'T', 'E', '1', '\n',
};
static const pl_u8 EDGE_MAGIC[8] = {
    'R', 'E', 'D', 'G', 'E', '1', '\n', 0,
};

static pl_u32 read_u24(const pl_u8 *source)
{
    return (pl_u32)source[0]
         | ((pl_u32)source[1] << 8u)
         | ((pl_u32)source[2] << 16u);
}

static void write_u24(pl_u8 *target, pl_u32 value)
{
    target[0] = (pl_u8)value;
    target[1] = (pl_u8)(value >> 8u);
    target[2] = (pl_u8)(value >> 16u);
}

static pl_u32 read_u32(const pl_u8 *source)
{
    return (pl_u32)source[0]
         | ((pl_u32)source[1] << 8u)
         | ((pl_u32)source[2] << 16u)
         | ((pl_u32)source[3] << 24u);
}

static void write_u32(pl_u8 *target, pl_u32 value)
{
    target[0] = (pl_u8)value;
    target[1] = (pl_u8)(value >> 8u);
    target[2] = (pl_u8)(value >> 16u);
    target[3] = (pl_u8)(value >> 24u);
}

static pl_u64 read_u64(const pl_u8 *source)
{
    pl_u64 value = 0u;
    for (pl_u32 byte = 0u; byte < 8u; ++byte)
        value |= (pl_u64)source[byte] << (byte * 8u);
    return value;
}

static void write_u64(pl_u8 *target, pl_u64 value)
{
    for (pl_u32 byte = 0u; byte < 8u; ++byte)
        target[byte] = (pl_u8)(value >> (byte * 8u));
}

static int same_magic(const pl_u8 *source, const pl_u8 expected[8])
{
    pl_u32 difference = 0u;
    for (pl_u32 index = 0u; index < 8u; ++index)
        difference |= (pl_u32)(source[index] ^ expected[index]);
    return difference == 0u;
}

static int all_zero(const pl_u8 *source, pl_u32 bytes)
{
    pl_u32 any = 0u;
    for (pl_u32 index = 0u; index < bytes; ++index) any |= source[index];
    return any == 0u;
}

static pl_u32 popcount64(pl_u64 value)
{
    value -= (value >> 1u) & 0x5555555555555555ull;
    value = (value & 0x3333333333333333ull)
          + ((value >> 2u) & 0x3333333333333333ull);
    value = (value + (value >> 4u)) & 0x0f0f0f0f0f0f0f0full;
    return (pl_u32)((value * 0x0101010101010101ull) >> 56u);
}

static pl_u32 words_for(pl_u32 states)
{
    return states / 64u + (states % 64u != 0u);
}

static pl_u64 lower_mask(pl_u32 bit)
{
    return bit ? ((1ull << bit) - 1ull) : 0ull;
}

static pl_u32 bit_at(const pl_u64 *bits, pl_u32 state)
{
    return (pl_u32)((bits[state >> 6u] >> (state & 63u)) & 1u);
}

static pl_u32 rank_at(const pl_u64 *bits, const pl_u32 *prefix,
                      pl_u32 state)
{
    pl_u32 word = state >> 6u;
    pl_u32 bit = state & 63u;
    return prefix[word] + popcount64(bits[word] & lower_mask(bit));
}

int pl_residual_builder_open(pl_residual_builder *builder,
                             pl_u32 *kernels, pl_u32 state_capacity,
                             pl_u64 *zero_bits, pl_u64 *two_bits,
                             pl_u32 *zero_prefix, pl_u32 *two_prefix,
                             pl_u32 word_capacity,
                             pl_u32 *edge_next, pl_i32 *edge_rip_delta,
                             pl_u32 edge_capacity)
{
    if (!builder || !kernels || !state_capacity || !zero_bits || !two_bits
            || !zero_prefix || !two_prefix || !word_capacity
            || word_capacity < words_for(state_capacity)
            || !edge_next || !edge_rip_delta || !edge_capacity)
        return PL_ERROR_RESIDUAL;
    builder->kernels = kernels;
    builder->zero_bits = zero_bits;
    builder->two_bits = two_bits;
    builder->zero_prefix = zero_prefix;
    builder->two_prefix = two_prefix;
    builder->edge_next = edge_next;
    builder->edge_rip_delta = edge_rip_delta;
    builder->state_capacity = state_capacity;
    builder->edge_capacity = edge_capacity;
    builder->word_capacity = word_capacity;
    builder->state_count = 0u;
    builder->edge_count = 0u;
    for (pl_u32 word = 0u; word < word_capacity; ++word) {
        zero_bits[word] = 0u;
        two_bits[word] = 0u;
    }
    return 0;
}

int pl_residual_add(pl_residual_builder *builder, pl_u32 kernel,
                    pl_u32 degree, const pl_u32 next[2],
                    const pl_i32 rip_delta[2], pl_u32 *rank)
{
    if (!builder || !rank || degree > 2u
            || (degree && (!next || !rip_delta)))
        return PL_ERROR_RESIDUAL;
    if (builder->state_count >= builder->state_capacity
            || degree > builder->edge_capacity - builder->edge_count)
        return PL_ERROR_RESIDUAL_CAPACITY;
    pl_u32 state = builder->state_count++;
    builder->kernels[state] = kernel;
    pl_u64 bit = 1ull << (state & 63u);
    if (!degree) builder->zero_bits[state >> 6u] |= bit;
    if (degree == 2u) builder->two_bits[state >> 6u] |= bit;
    for (pl_u32 arm = 0u; arm < degree; ++arm) {
        pl_u32 edge = builder->edge_count++;
        builder->edge_next[edge] = next[arm];
        builder->edge_rip_delta[edge] = rip_delta[arm];
    }
    *rank = state;
    return 0;
}

int pl_residual_finish(pl_residual_builder *builder, pl_u32 kernel_count,
                       pl_residual_graph *out)
{
    if (!builder || !out || !kernel_count) return PL_ERROR_RESIDUAL;
    pl_u32 words = words_for(builder->state_count);
    if (!words || words > builder->word_capacity)
        return PL_ERROR_RESIDUAL_CAPACITY;
    builder->zero_prefix[0] = 0u;
    builder->two_prefix[0] = 0u;
    for (pl_u32 word = 0u; word < words; ++word) {
        pl_u32 zero = popcount64(builder->zero_bits[word]);
        pl_u32 two = popcount64(builder->two_bits[word]);
        if (builder->zero_prefix[word] > 0xffffffffu - zero
                || builder->two_prefix[word] > 0xffffffffu - two)
            return PL_ERROR_RESIDUAL_CAPACITY;
        builder->zero_prefix[word + 1u] =
            builder->zero_prefix[word] + zero;
        builder->two_prefix[word + 1u] =
            builder->two_prefix[word] + two;
    }
    pl_u32 expected = builder->state_count;
    pl_u32 zero = builder->zero_prefix[words];
    pl_u32 two = builder->two_prefix[words];
    if (zero > expected || two > 0xffffffffu - expected
            || expected + two - zero != builder->edge_count)
        return PL_ERROR_RESIDUAL;
    out->kernels = builder->kernels;
    out->zero_bits = builder->zero_bits;
    out->two_bits = builder->two_bits;
    out->zero_prefix = builder->zero_prefix;
    out->two_prefix = builder->two_prefix;
    out->edge_next = builder->edge_next;
    out->edge_rip_delta = builder->edge_rip_delta;
    out->state_count = builder->state_count;
    out->edge_count = builder->edge_count;
    out->kernel_count = kernel_count;
    out->word_count = words;
    return pl_residual_validate(out);
}

int pl_residual_validate(const pl_residual_graph *graph)
{
    if (!graph || !graph->kernels || !graph->zero_bits || !graph->two_bits
            || !graph->zero_prefix || !graph->two_prefix
            || !graph->edge_next || !graph->edge_rip_delta
            || !graph->state_count || !graph->kernel_count
            || graph->word_count != words_for(graph->state_count))
        return PL_ERROR_RESIDUAL;
    for (pl_u32 word = 0u; word < graph->word_count; ++word) {
        if (graph->zero_bits[word] & graph->two_bits[word])
            return PL_ERROR_RESIDUAL;
        if (graph->zero_prefix[word + 1u]
                != graph->zero_prefix[word]
                   + popcount64(graph->zero_bits[word])
                || graph->two_prefix[word + 1u]
                   != graph->two_prefix[word]
                      + popcount64(graph->two_bits[word]))
            return PL_ERROR_RESIDUAL;
    }
    if (graph->zero_prefix[graph->word_count] > graph->state_count
            || graph->state_count
               + graph->two_prefix[graph->word_count]
               - graph->zero_prefix[graph->word_count]
               != graph->edge_count)
        return PL_ERROR_RESIDUAL;
    for (pl_u32 state = 0u; state < graph->state_count; ++state)
        if (graph->kernels[state] >= graph->kernel_count)
            return PL_ERROR_RESIDUAL;
    for (pl_u32 edge = 0u; edge < graph->edge_count; ++edge)
        if (graph->edge_next[edge] >= graph->state_count
                && graph->edge_next[edge] != PL_RESIDUAL_RESOLVE)
            return PL_ERROR_RESIDUAL;
    return 0;
}

int pl_residual_page_writer_open(
    pl_residual_page_writer *writer, const pl_residual_graph *graph)
{
    if (!writer || pl_residual_validate(graph)) return PL_ERROR_RESIDUAL;
    writer->graph = graph;
    return 0;
}

int pl_residual_state(const pl_residual_graph *graph, pl_u32 state,
                      pl_u32 *kernel, pl_u32 *degree, pl_u32 *edge_base)
{
    if (!graph || !kernel || !degree || !edge_base
            || state >= graph->state_count)
        return PL_ERROR_RESIDUAL;
    pl_u32 zero = bit_at(graph->zero_bits, state);
    pl_u32 two = bit_at(graph->two_bits, state);
    if (zero && two) return PL_ERROR_RESIDUAL;
    pl_u32 base = state
                + rank_at(graph->two_bits, graph->two_prefix, state)
                - rank_at(graph->zero_bits, graph->zero_prefix, state);
    pl_u32 count = 1u + two - zero;
    if (base > graph->edge_count || count > graph->edge_count - base
            || graph->kernels[state] >= graph->kernel_count)
        return PL_ERROR_RESIDUAL;
    *kernel = graph->kernels[state];
    *degree = count;
    *edge_base = base;
    return 0;
}

int pl_residual_edge(const pl_residual_graph *graph, pl_u32 state,
                     pl_u32 arm, pl_u32 *next, pl_i32 *rip_delta)
{
    if (!next || !rip_delta) return PL_ERROR_RESIDUAL;
    pl_u32 kernel = 0u, degree = 0u, base = 0u;
    int status = pl_residual_state(
        graph, state, &kernel, &degree, &base);
    (void)kernel;
    if (status || arm >= degree) return status ? status : PL_ERROR_RESIDUAL;
    pl_u32 edge = base + arm;
    if (edge >= graph->edge_count
            || (graph->edge_next[edge] >= graph->state_count
                && graph->edge_next[edge] != PL_RESIDUAL_RESOLVE))
        return PL_ERROR_RESIDUAL;
    *next = graph->edge_next[edge];
    *rip_delta = graph->edge_rip_delta[edge];
    return 0;
}

static int edges_before(const pl_residual_graph *graph, pl_u32 state,
                        pl_u32 *edge)
{
    if (!graph || !edge || state > graph->state_count)
        return PL_ERROR_RESIDUAL;
    if (state == graph->state_count) {
        *edge = graph->edge_count;
        return 0;
    }
    pl_u32 kernel = 0u, degree = 0u;
    return pl_residual_state(graph, state, &kernel, &degree, edge);
}

static int residual_state_page_write(
    const pl_residual_graph *graph, pl_u32 page_rank,
    pl_u8 target[PL_RESIDUAL_PAGE_BYTES])
{
    if (!graph || !target
            || page_rank >= (graph->state_count
                              + PL_RESIDUAL_STATE_PAGE_STATES - 1u)
                             / PL_RESIDUAL_STATE_PAGE_STATES)
        return PL_ERROR_RESIDUAL;
    for (pl_u32 index = 0u; index < PL_RESIDUAL_PAGE_BYTES; ++index)
        target[index] = 0u;
    for (pl_u32 index = 0u; index < 8u; ++index)
        target[index] = STATE_MAGIC[index];
    pl_u32 first = page_rank * PL_RESIDUAL_STATE_PAGE_STATES;
    pl_u32 count = graph->state_count - first;
    if (count > PL_RESIDUAL_STATE_PAGE_STATES)
        count = PL_RESIDUAL_STATE_PAGE_STATES;
    pl_u32 first_edge = 0u, final_edge = 0u;
    int status = edges_before(graph, first, &first_edge);
    if (!status) status = edges_before(graph, first + count, &final_edge);
    if (status || final_edge < first_edge) return PL_ERROR_RESIDUAL;
    write_u32(target + 8u, page_rank);
    write_u32(target + 12u, count);
    write_u32(target + 16u, first_edge);
    write_u32(target + 20u, final_edge - first_edge);
    for (pl_u32 local = 0u; local < count; ++local) {
        pl_u32 kernel = graph->kernels[first + local];
        if (kernel >= graph->kernel_count || kernel >= (1u << 24u))
            return PL_ERROR_RESIDUAL_CAPACITY;
        write_u24(target + PL_RESIDUAL_STATE_PAGE_KERNELS + local * 3u,
                  kernel);
    }
    pl_u32 first_word = first / 64u;
    pl_u32 words = count / 64u + (count % 64u != 0u);
    for (pl_u32 word = 0u; word < words; ++word) {
        write_u64(target + PL_RESIDUAL_STATE_PAGE_ZERO_BITS + word * 8u,
                  graph->zero_bits[first_word + word]);
        write_u64(target + PL_RESIDUAL_STATE_PAGE_TWO_BITS + word * 8u,
                  graph->two_bits[first_word + word]);
    }
    return 0;
}

int pl_residual_state_page_writer_write(
    const pl_residual_page_writer *writer, pl_u32 page_rank,
    pl_u8 target[PL_RESIDUAL_PAGE_BYTES])
{
    return !writer || !writer->graph ? PL_ERROR_RESIDUAL
        : residual_state_page_write(writer->graph, page_rank, target);
}

int pl_residual_state_page_write(
    const pl_residual_graph *graph, pl_u32 page_rank,
    pl_u8 target[PL_RESIDUAL_PAGE_BYTES])
{
    pl_residual_page_writer writer;
    int status = pl_residual_page_writer_open(&writer, graph);
    return status ? status
                  : pl_residual_state_page_writer_write(
                      &writer, page_rank, target);
}

int pl_residual_state_page_open(
    const pl_u8 page[PL_RESIDUAL_PAGE_BYTES], pl_u32 page_rank,
    pl_u32 state_count, pl_u32 edge_count, pl_u32 kernel_count)
{
    if (!page || !state_count || !kernel_count
            || !same_magic(page, STATE_MAGIC)
            || read_u32(page + 8u) != page_rank
            || !all_zero(page + 24u,
                         PL_RESIDUAL_STATE_PAGE_HEADER - 24u)
            || !all_zero(page + PL_RESIDUAL_STATE_PAGE_USED,
                         PL_RESIDUAL_PAGE_BYTES
                         - PL_RESIDUAL_STATE_PAGE_USED))
        return PL_ERROR_RESIDUAL;
    if (page_rank > 0xffffffffu / PL_RESIDUAL_STATE_PAGE_STATES)
        return PL_ERROR_RESIDUAL;
    pl_u32 first = page_rank * PL_RESIDUAL_STATE_PAGE_STATES;
    if (first >= state_count) return PL_ERROR_RESIDUAL;
    pl_u32 expected = state_count - first;
    if (expected > PL_RESIDUAL_STATE_PAGE_STATES)
        expected = PL_RESIDUAL_STATE_PAGE_STATES;
    pl_u32 count = read_u32(page + 12u);
    pl_u32 first_edge = read_u32(page + 16u);
    pl_u32 edges = read_u32(page + 20u);
    if (count != expected || first_edge > edge_count
            || edges > edge_count - first_edge)
        return PL_ERROR_RESIDUAL;
    pl_u32 observed_edges = 0u;
    for (pl_u32 local = 0u; local < count; ++local) {
        pl_u32 kernel = read_u24(
            page + PL_RESIDUAL_STATE_PAGE_KERNELS + local * 3u);
        pl_u64 zero_word = read_u64(
            page + PL_RESIDUAL_STATE_PAGE_ZERO_BITS
            + (local >> 6u) * 8u);
        pl_u64 two_word = read_u64(
            page + PL_RESIDUAL_STATE_PAGE_TWO_BITS
            + (local >> 6u) * 8u);
        pl_u32 bit = local & 63u;
        pl_u32 zero = (pl_u32)((zero_word >> bit) & 1u);
        pl_u32 two = (pl_u32)((two_word >> bit) & 1u);
        if (kernel >= kernel_count || (zero && two))
            return PL_ERROR_RESIDUAL;
        observed_edges += 1u + two - zero;
    }
    if (observed_edges != edges) return PL_ERROR_RESIDUAL;
    if (!all_zero(
            page + PL_RESIDUAL_STATE_PAGE_KERNELS + count * 3u,
            PL_RESIDUAL_STATE_PAGE_ZERO_BITS
            - PL_RESIDUAL_STATE_PAGE_KERNELS - count * 3u))
        return PL_ERROR_RESIDUAL;
    pl_u32 words = count / 64u + (count % 64u != 0u);
    if (!all_zero(page + PL_RESIDUAL_STATE_PAGE_ZERO_BITS + words * 8u,
                  PL_RESIDUAL_STATE_PAGE_TWO_BITS
                  - PL_RESIDUAL_STATE_PAGE_ZERO_BITS - words * 8u)
            || !all_zero(
                page + PL_RESIDUAL_STATE_PAGE_TWO_BITS + words * 8u,
                PL_RESIDUAL_STATE_PAGE_USED
                - PL_RESIDUAL_STATE_PAGE_TWO_BITS - words * 8u))
        return PL_ERROR_RESIDUAL;
    if (count & 63u) {
        pl_u64 unused = ~lower_mask(count & 63u);
        if ((read_u64(page + PL_RESIDUAL_STATE_PAGE_ZERO_BITS
                      + (words - 1u) * 8u) & unused)
                || (read_u64(page + PL_RESIDUAL_STATE_PAGE_TWO_BITS
                             + (words - 1u) * 8u) & unused))
            return PL_ERROR_RESIDUAL;
    }
    return 0;
}

int pl_residual_state_page_kernel(
    const pl_u8 page[PL_RESIDUAL_PAGE_BYTES], pl_u32 local,
    pl_u32 *kernel)
{
    if (!page || !kernel || local >= read_u32(page + 12u)
            || local >= PL_RESIDUAL_STATE_PAGE_STATES)
        return PL_ERROR_RESIDUAL;
    *kernel = read_u24(
        page + PL_RESIDUAL_STATE_PAGE_KERNELS + local * 3u);
    return 0;
}

int pl_residual_state_page_edge_base(
    const pl_u8 page[PL_RESIDUAL_PAGE_BYTES], pl_u32 local,
    pl_u32 *degree, pl_u32 *edge_base)
{
    if (!page || !degree || !edge_base || local >= read_u32(page + 12u)
            || local >= PL_RESIDUAL_STATE_PAGE_STATES)
        return PL_ERROR_RESIDUAL;
    pl_u32 zero_rank = 0u, two_rank = 0u;
    pl_u32 word_limit = local >> 6u;
    for (pl_u32 word = 0u; word < word_limit; ++word) {
        zero_rank += popcount64(read_u64(
            page + PL_RESIDUAL_STATE_PAGE_ZERO_BITS + word * 8u));
        two_rank += popcount64(read_u64(
            page + PL_RESIDUAL_STATE_PAGE_TWO_BITS + word * 8u));
    }
    pl_u32 bit = local & 63u;
    pl_u64 mask = lower_mask(bit);
    pl_u64 zero_word = read_u64(
        page + PL_RESIDUAL_STATE_PAGE_ZERO_BITS + word_limit * 8u);
    pl_u64 two_word = read_u64(
        page + PL_RESIDUAL_STATE_PAGE_TWO_BITS + word_limit * 8u);
    zero_rank += popcount64(zero_word & mask);
    two_rank += popcount64(two_word & mask);
    pl_u32 zero = (pl_u32)((zero_word >> bit) & 1u);
    pl_u32 two = (pl_u32)((two_word >> bit) & 1u);
    if (zero && two) return PL_ERROR_RESIDUAL;
    *degree = 1u + two - zero;
    *edge_base = read_u32(page + 16u) + local + two_rank - zero_rank;
    return 0;
}

static int residual_edge_page_write(
    const pl_residual_graph *graph, pl_u32 page_rank,
    pl_u8 target[PL_RESIDUAL_PAGE_BYTES])
{
    if (!graph || !target
            || page_rank >= (graph->edge_count
                              + PL_RESIDUAL_EDGE_PAGE_EDGES - 1u)
                             / PL_RESIDUAL_EDGE_PAGE_EDGES)
        return PL_ERROR_RESIDUAL;
    for (pl_u32 index = 0u; index < PL_RESIDUAL_PAGE_BYTES; ++index)
        target[index] = 0u;
    for (pl_u32 index = 0u; index < 8u; ++index)
        target[index] = EDGE_MAGIC[index];
    pl_u32 first = page_rank * PL_RESIDUAL_EDGE_PAGE_EDGES;
    pl_u32 count = graph->edge_count - first;
    if (count > PL_RESIDUAL_EDGE_PAGE_EDGES)
        count = PL_RESIDUAL_EDGE_PAGE_EDGES;
    write_u32(target + 8u, page_rank);
    write_u32(target + 12u, count);
    for (pl_u32 local = 0u; local < count; ++local) {
        pl_u32 next = graph->edge_next[first + local];
        if (next == PL_RESIDUAL_RESOLVE) next = 0xffffffu;
        else if (next >= (1u << 24u))
            return PL_ERROR_RESIDUAL_CAPACITY;
        write_u24(target + PL_RESIDUAL_EDGE_PAGE_NEXT + local * 3u, next);
        write_u32(target + PL_RESIDUAL_EDGE_PAGE_DELTA + local * 4u,
                  (pl_u32)graph->edge_rip_delta[first + local]);
    }
    return 0;
}

int pl_residual_edge_page_writer_write(
    const pl_residual_page_writer *writer, pl_u32 page_rank,
    pl_u8 target[PL_RESIDUAL_PAGE_BYTES])
{
    return !writer || !writer->graph ? PL_ERROR_RESIDUAL
        : residual_edge_page_write(writer->graph, page_rank, target);
}

int pl_residual_edge_page_write(
    const pl_residual_graph *graph, pl_u32 page_rank,
    pl_u8 target[PL_RESIDUAL_PAGE_BYTES])
{
    pl_residual_page_writer writer;
    int status = pl_residual_page_writer_open(&writer, graph);
    return status ? status
                  : pl_residual_edge_page_writer_write(
                      &writer, page_rank, target);
}

int pl_residual_edge_page_open(
    const pl_u8 page[PL_RESIDUAL_PAGE_BYTES], pl_u32 page_rank,
    pl_u32 state_count, pl_u32 edge_count)
{
    if (!page || !state_count || state_count > 0xffffffu
            || !same_magic(page, EDGE_MAGIC)
            || read_u32(page + 8u) != page_rank
            || !all_zero(page + 16u,
                         PL_RESIDUAL_EDGE_PAGE_HEADER - 16u)
            || !all_zero(page + PL_RESIDUAL_EDGE_PAGE_USED,
                         PL_RESIDUAL_PAGE_BYTES
                         - PL_RESIDUAL_EDGE_PAGE_USED))
        return PL_ERROR_RESIDUAL;
    if (page_rank > 0xffffffffu / PL_RESIDUAL_EDGE_PAGE_EDGES)
        return PL_ERROR_RESIDUAL;
    pl_u32 first = page_rank * PL_RESIDUAL_EDGE_PAGE_EDGES;
    if (first >= edge_count) return PL_ERROR_RESIDUAL;
    pl_u32 expected = edge_count - first;
    if (expected > PL_RESIDUAL_EDGE_PAGE_EDGES)
        expected = PL_RESIDUAL_EDGE_PAGE_EDGES;
    pl_u32 count = read_u32(page + 12u);
    if (count != expected) return PL_ERROR_RESIDUAL;
    for (pl_u32 local = 0u; local < count; ++local) {
        pl_u32 next = read_u24(
            page + PL_RESIDUAL_EDGE_PAGE_NEXT + local * 3u);
        if (next >= state_count && next != 0xffffffu)
            return PL_ERROR_RESIDUAL;
    }
    if (!all_zero(page + PL_RESIDUAL_EDGE_PAGE_NEXT + count * 3u,
                  PL_RESIDUAL_EDGE_PAGE_DELTA
                  - PL_RESIDUAL_EDGE_PAGE_NEXT - count * 3u)
            || !all_zero(
                page + PL_RESIDUAL_EDGE_PAGE_DELTA + count * 4u,
                PL_RESIDUAL_EDGE_PAGE_USED
                - PL_RESIDUAL_EDGE_PAGE_DELTA - count * 4u))
        return PL_ERROR_RESIDUAL;
    return 0;
}

int pl_residual_edge_page_get(
    const pl_u8 page[PL_RESIDUAL_PAGE_BYTES], pl_u32 local,
    pl_u32 *next, pl_i32 *rip_delta)
{
    if (!page || !next || !rip_delta || local >= read_u32(page + 12u)
            || local >= PL_RESIDUAL_EDGE_PAGE_EDGES)
        return PL_ERROR_RESIDUAL;
    pl_u32 encoded = read_u24(
        page + PL_RESIDUAL_EDGE_PAGE_NEXT + local * 3u);
    *next = encoded == 0xffffffu ? PL_RESIDUAL_RESOLVE : encoded;
    *rip_delta = (pl_i32)read_u32(
        page + PL_RESIDUAL_EDGE_PAGE_DELTA + local * 4u);
    return 0;
}

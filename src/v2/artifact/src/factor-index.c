#include <artifact/factor-index.h>

#define U32_MAX_VALUE 0xffffffffu
#define LCP_BLOCK 16u
#define BYTE_PAGE_SHIFT 12u
#define BYTE_PAGE_SIZE (1u << BYTE_PAGE_SHIFT)
#define CHOICE_LENGTH_MASK 0x0fffffffu
#define CHOICE_COST_SHIFT 28u

static pl_u32 bit_width(pl_u32 value)
{
    pl_u32 width = 0u;
    do {
        ++width;
        value >>= 1u;
    } while (value);
    return width;
}

static int tree_extent(pl_u32 bytes, pl_u32 *blocks, pl_u32 *capacity)
{
    if (!bytes || !blocks || !capacity
            || bytes > CHOICE_LENGTH_MASK)
        return 0;
    *blocks = (bytes + LCP_BLOCK - 1u) / LCP_BLOCK;
    /* `capacity` counts u64 words. B words are the iterative 2B-u32 LCP
     * tree. During the disjoint cost phase their first B u32 lanes hold the
     * block-end costs; each coordinate's 4-bit delta is substituted into the
     * dead high nibble of its length cell. */
    *capacity = *blocks;
    return 1;
}

int artifact_factor_index_measure(pl_u32 bytes,
                                  pl_u32 *vector_capacity,
                                  pl_u32 *tree_capacity)
{
    pl_u32 blocks = 0u;
    if (!bytes || bytes == U32_MAX_VALUE
            || !vector_capacity || !tree_capacity
            || !tree_extent(bytes, &blocks, tree_capacity))
        return ARTIFACT_ERROR_FACTOR_RANGE;
    (void)blocks;
    *vector_capacity = bytes + 1u;
    return 0;
}

static int workspace_valid(
    const artifact_factor_index_workspace *workspace, pl_u32 bytes)
{
    pl_u32 vector = 0u, tree = 0u;
    return workspace
        && !artifact_factor_index_measure(
            bytes, &vector, &tree)
        && workspace->source && workspace->length
        && workspace->suffix_array && workspace->rank
        && workspace->cost_tree
        && workspace->vector_capacity >= vector
        && workspace->tree_capacity >= tree;
}

static int suffix_is_lms(const pl_u32 *type, pl_u32 coordinate)
{
    return coordinate && type[coordinate] && !type[coordinate - 1u];
}

typedef struct {
    const artifact_byte_view *bytes;
    const pl_u32 *word;
    const pl_u32 *page_span;
    pl_u32 byte_count;
} factor_symbol_view;

static pl_u32 payload_owner(const artifact_byte_view *view, pl_u32 span)
{
    return view->representative ? view->representative[span] : span;
}

static int byte_page_directory_build(
    const artifact_byte_view *view, pl_u32 bytes,
    pl_u32 *directory, pl_u32 capacity)
{
    pl_u32 pages = (bytes + BYTE_PAGE_SIZE - 1u) >> BYTE_PAGE_SHIFT;
    if (!view || !directory || capacity < pages + 1u) return 0;
    pl_u32 span = 0u;
    for (pl_u32 page = 0u; page < pages; ++page) {
        pl_u64 coordinate = (pl_u64)page << BYTE_PAGE_SHIFT;
        while (span < view->spans && view->end[span] <= coordinate) ++span;
        if (span >= view->spans) return 0;
        directory[page] = span;
    }
    directory[pages] = view->spans;
    return 1;
}

static pl_u32 byte_span_at(
    const factor_symbol_view *symbols, pl_u32 coordinate)
{
    const artifact_byte_view *view = symbols->bytes;
    pl_u32 page = coordinate >> BYTE_PAGE_SHIFT;
    pl_u32 span = symbols->page_span[page];
    if ((pl_u64)coordinate >= view->end[span]) {
        pl_u32 low = span + 1u;
        pl_u32 high = symbols->page_span[page + 1u];
        if (high < view->spans) ++high;
        while (low < high) {
            pl_u32 middle = low + (high - low) / 2u;
            if ((pl_u64)coordinate < view->end[middle]) high = middle;
            else low = middle + 1u;
        }
        span = low;
    }
    return span;
}

static pl_u8 byte_at(
    const factor_symbol_view *symbols, pl_u32 coordinate)
{
    const artifact_byte_view *view = symbols->bytes;
    pl_u32 span = byte_span_at(symbols, coordinate);
    pl_u64 first = span ? view->end[span - 1u] : 0u;
    pl_u32 owner = payload_owner(view, span);
    return view->payload[owner].bytes[(pl_u64)coordinate - first];
}

static pl_u32 byte_common_prefix(
    const factor_symbol_view *symbols,
    pl_u32 left, pl_u32 right, pl_u32 limit)
{
    if (!limit) return 0u;
    const artifact_byte_view *view = symbols->bytes;
    pl_u32 left_span = byte_span_at(symbols, left);
    pl_u32 right_span = byte_span_at(symbols, right);
    pl_u32 matched = 0u;
    while (matched < limit) {
        while (view->end[left_span] == left) ++left_span;
        while (view->end[right_span] == right) ++right_span;
        pl_u64 left_first = left_span ? view->end[left_span - 1u] : 0u;
        pl_u64 right_first = right_span ? view->end[right_span - 1u] : 0u;
        pl_u32 left_owner = payload_owner(view, left_span);
        pl_u32 right_owner = payload_owner(view, right_span);
        const pl_u8 *left_bytes = view->payload[left_owner].bytes
            + ((pl_u64)left - left_first);
        const pl_u8 *right_bytes = view->payload[right_owner].bytes
            + ((pl_u64)right - right_first);
        pl_u64 left_available = view->end[left_span] - left;
        pl_u64 right_available = view->end[right_span] - right;
        pl_u32 take = limit - matched;
        if (left_available < take) take = (pl_u32)left_available;
        if (right_available < take) take = (pl_u32)right_available;
        for (pl_u32 index = 0u; index < take; ++index)
            if (left_bytes[index] != right_bytes[index])
                return matched + index;
        left += take;
        right += take;
        matched += take;
    }
    return matched;
}

static pl_u32 symbol_at(
    const factor_symbol_view *symbols, pl_u32 coordinate)
{
    if (symbols->word) return symbols->word[coordinate];
    return coordinate == symbols->byte_count ? 0u
        : (pl_u32)byte_at(symbols, coordinate) + 1u;
}

static void suffix_types(
    const factor_symbol_view *symbols, pl_u32 size, pl_u32 *type)
{
    type[size - 1u] = 1u;
    for (pl_u32 coordinate = size - 1u; coordinate-- > 0u;) {
        pl_u32 current = symbol_at(symbols, coordinate);
        pl_u32 next = symbol_at(symbols, coordinate + 1u);
        type[coordinate] = current < next
            || (current == next
                && type[coordinate + 1u]);
    }
}

static void suffix_bucket_counts(const factor_symbol_view *symbols, pl_u32 size,
                                 pl_u32 alphabet, pl_u32 *bucket)
{
    for (pl_u32 symbol = 0u; symbol < alphabet; ++symbol)
        bucket[symbol] = 0u;
    for (pl_u32 coordinate = 0u; coordinate < size; ++coordinate)
        ++bucket[symbol_at(symbols, coordinate)];
}

static void suffix_bucket_heads(pl_u32 alphabet, pl_u32 *bucket)
{
    pl_u32 at = 0u;
    for (pl_u32 symbol = 0u; symbol < alphabet; ++symbol) {
        pl_u32 count = bucket[symbol];
        bucket[symbol] = at;
        at += count;
    }
}

static void suffix_bucket_tails(pl_u32 alphabet, pl_u32 *bucket)
{
    pl_u32 at = 0u;
    for (pl_u32 symbol = 0u; symbol < alphabet; ++symbol) {
        at += bucket[symbol];
        bucket[symbol] = at - 1u;
    }
}

static void suffix_induce(const factor_symbol_view *symbols, pl_u32 size,
                          pl_u32 alphabet, const pl_u32 *type,
                          const pl_u32 *lms, pl_u32 lms_count,
                          pl_u32 *suffix_array, pl_u32 *bucket)
{
    for (pl_u32 order = 0u; order < size; ++order)
        suffix_array[order] = U32_MAX_VALUE;
    suffix_bucket_counts(symbols, size, alphabet, bucket);
    suffix_bucket_tails(alphabet, bucket);
    for (pl_u32 index = lms_count; index-- > 0u;) {
        pl_u32 coordinate = lms[index];
        suffix_array[bucket[symbol_at(symbols, coordinate)]--] = coordinate;
    }
    suffix_bucket_counts(symbols, size, alphabet, bucket);
    suffix_bucket_heads(alphabet, bucket);
    for (pl_u32 order = 0u; order < size; ++order) {
        pl_u32 coordinate = suffix_array[order];
        if (coordinate == U32_MAX_VALUE || !coordinate) continue;
        pl_u32 prior = coordinate - 1u;
        if (!type[prior])
            suffix_array[bucket[symbol_at(symbols, prior)]++] = prior;
    }
    suffix_bucket_counts(symbols, size, alphabet, bucket);
    suffix_bucket_tails(alphabet, bucket);
    for (pl_u32 order = size; order-- > 0u;) {
        pl_u32 coordinate = suffix_array[order];
        if (coordinate == U32_MAX_VALUE || !coordinate) continue;
        pl_u32 prior = coordinate - 1u;
        if (type[prior])
            suffix_array[bucket[symbol_at(symbols, prior)]--] = prior;
    }
}

static int suffix_lms_equal(const factor_symbol_view *symbols,
                            const pl_u32 *type,
                            pl_u32 size, pl_u32 left, pl_u32 right)
{
    if (left == right) return 1;
    for (pl_u32 offset = 0u;; ++offset) {
        if (left + offset >= size || right + offset >= size
                || symbol_at(symbols, left + offset)
                   != symbol_at(symbols, right + offset)
                || type[left + offset] != type[right + offset])
            return 0;
        int left_lms = suffix_is_lms(type, left + offset);
        int right_lms = suffix_is_lms(type, right + offset);
        if (offset && (left_lms || right_lms))
            return left_lms && right_lms;
    }
}

/* SA-IS with one explicit unique sentinel.  `type` and `scratch` are two
 * N-word phase columns; recursive reduced words occupy the lower and upper
 * halves of `type`, so no recursion allocation or comparison-doubling pass
 * exists. */
static int suffix_induced_sort(const factor_symbol_view *symbols, pl_u32 size,
                               pl_u32 alphabet, pl_u32 *suffix_array,
                               pl_u32 *type, pl_u32 *scratch,
                               pl_u32 *bucket)
{
    if (!symbols || !suffix_array || !type || !scratch || !bucket
            || !size || !alphabet)
        return ARTIFACT_ERROR_FACTOR;
    if (size == 1u) {
        suffix_array[0] = 0u;
        return 0;
    }
    suffix_types(symbols, size, type);
    pl_u32 lms_count = 0u;
    for (pl_u32 coordinate = 1u; coordinate < size; ++coordinate)
        if (suffix_is_lms(type, coordinate))
            scratch[lms_count++] = coordinate;
    if (!lms_count || lms_count > size / 2u)
        return ARTIFACT_ERROR_FACTOR;
    suffix_induce(symbols, size, alphabet, type,
                  scratch, lms_count, suffix_array, bucket);

    pl_u32 sorted = 0u;
    for (pl_u32 order = 0u; order < size; ++order)
        if (suffix_array[order] != U32_MAX_VALUE
                && suffix_is_lms(type, suffix_array[order]))
            scratch[sorted++] = suffix_array[order];
    if (sorted != lms_count) return ARTIFACT_ERROR_FACTOR;
    pl_u32 names = 0u;
    pl_u32 previous = U32_MAX_VALUE;
    for (pl_u32 index = 0u; index < lms_count; ++index) {
        pl_u32 coordinate = scratch[index];
        if (previous == U32_MAX_VALUE
                || !suffix_lms_equal(
                    symbols, type, size, previous, coordinate))
            ++names;
        bucket[coordinate] = names - 1u;
        previous = coordinate;
    }
    pl_u32 reduced = 0u;
    for (pl_u32 coordinate = 1u; coordinate < size; ++coordinate)
        if (suffix_is_lms(type, coordinate))
            type[reduced++] = bucket[coordinate];
    if (reduced != lms_count) return ARTIFACT_ERROR_FACTOR;
    if (names == lms_count) {
        for (pl_u32 index = 0u; index < lms_count; ++index)
            suffix_array[type[index]] = index;
    } else {
        factor_symbol_view reduced_symbols = { 0, type, 0, 0u };
        int status = suffix_induced_sort(
            &reduced_symbols, lms_count, names, suffix_array,
            type + lms_count, scratch, bucket);
        if (status) return status;
    }

    suffix_types(symbols, size, type);
    pl_u32 original = 0u;
    for (pl_u32 coordinate = 1u; coordinate < size; ++coordinate)
        if (suffix_is_lms(type, coordinate))
            scratch[lms_count + original++] = coordinate;
    if (original != lms_count || lms_count * 2u > size)
        return ARTIFACT_ERROR_FACTOR;
    for (pl_u32 index = 0u; index < lms_count; ++index) {
        pl_u32 rank = suffix_array[index];
        if (rank >= lms_count) return ARTIFACT_ERROR_FACTOR;
        scratch[index] = scratch[lms_count + rank];
    }
    suffix_induce(symbols, size, alphabet, type,
                  scratch, lms_count, suffix_array, bucket);
    return 0;
}

static int suffix_array_build(
    const artifact_byte_view *bytes, pl_u32 size,
    const artifact_factor_index_workspace *workspace)
{
    pl_u32 extent = size + 1u;
    pl_u32 *page_span = (pl_u32 *)(void *)workspace->cost_tree;
    pl_u32 page_capacity = workspace->tree_capacity * 2u;
    if (!byte_page_directory_build(
            bytes, size, page_span, page_capacity))
        return ARTIFACT_ERROR_FACTOR_RANGE;
    factor_symbol_view symbols = { bytes, 0, page_span, size };
    pl_u32 byte_bucket[257];
    pl_u32 *bucket = extent < 257u
        ? byte_bucket : workspace->rank;
    int status = suffix_induced_sort(
        &symbols, extent, 257u,
        workspace->suffix_array, workspace->source,
        workspace->length, bucket);
    if (status || workspace->suffix_array[0] != size)
        return status ? status : ARTIFACT_ERROR_FACTOR;
    for (pl_u32 order = 0u; order < size; ++order) {
        pl_u32 coordinate = workspace->suffix_array[order + 1u];
        if (coordinate >= size) return ARTIFACT_ERROR_FACTOR;
        workspace->suffix_array[order] = coordinate;
        workspace->rank[coordinate] = order;
    }
    return 0;
}

static void lcp_build(const artifact_byte_view *bytes, pl_u32 size,
                      const pl_u32 *page_span,
                      const artifact_factor_index_workspace *workspace,
                      pl_u32 *lcp)
{
    factor_symbol_view symbols = { bytes, 0, page_span, size };
    pl_u32 carried = 0u;
    for (pl_u32 coordinate = 0u; coordinate < size; ++coordinate) {
        pl_u32 order = workspace->rank[coordinate];
        if (!order) {
            lcp[order] = 0u;
            continue;
        }
        pl_u32 prior = workspace->suffix_array[order - 1u];
        pl_u32 coordinate_left = size - coordinate - carried;
        pl_u32 prior_left = size - prior - carried;
        pl_u32 limit = coordinate_left < prior_left
            ? coordinate_left : prior_left;
        carried += byte_common_prefix(
            &symbols, coordinate + carried, prior + carried, limit);
        lcp[order] = carried;
        if (carried) --carried;
    }
}

static pl_u32 minimum_u32(pl_u32 left, pl_u32 right)
{
    return left < right ? left : right;
}

static void minimum_tree_build(
    const pl_u32 *value, pl_u32 values,
    pl_u32 *tree, pl_u32 blocks)
{
    for (pl_u32 block = 0u; block < blocks; ++block) {
        pl_u32 first = block * LCP_BLOCK;
        pl_u32 last = first + LCP_BLOCK;
        if (last > values) last = values;
        pl_u32 minimum = U32_MAX_VALUE;
        for (pl_u32 at = first; at < last; ++at)
            minimum = minimum_u32(minimum, value[at]);
        tree[blocks + block] = minimum;
    }
    for (pl_u32 node = blocks; node-- > 1u;)
        tree[node] = minimum_u32(
            tree[node * 2u], tree[node * 2u + 1u]);
}

static pl_u32 minimum_tree_range(
    const pl_u32 *tree, pl_u32 blocks,
    pl_u32 first, pl_u32 last)
{
    pl_u32 result = U32_MAX_VALUE;
    for (first += blocks, last += blocks; first < last;
            first >>= 1u, last >>= 1u) {
        if (first & 1u)
            result = minimum_u32(result, tree[first++]);
        if (last & 1u)
            result = minimum_u32(result, tree[--last]);
    }
    return result;
}

static pl_u32 range_u32(
    const pl_u32 *value, pl_u32 values,
    const pl_u32 *tree, pl_u32 blocks,
    pl_u32 first, pl_u32 last)
{
    if (first >= last || last > values) return U32_MAX_VALUE;
    pl_u32 result = U32_MAX_VALUE;
    while (first < last && first % LCP_BLOCK)
        result = minimum_u32(result, value[first++]);
    pl_u32 first_block = first / LCP_BLOCK;
    pl_u32 last_block = last / LCP_BLOCK;
    if (first_block < last_block) {
        result = minimum_u32(result, minimum_tree_range(
            tree, blocks, first_block, last_block));
        first = last_block * LCP_BLOCK;
    }
    while (first < last)
        result = minimum_u32(result, value[first++]);
    return result;
}

static pl_u32 lcp_between(
    const pl_u32 *lcp, pl_u32 size,
    const pl_u32 *tree, pl_u32 blocks,
    pl_u32 left, pl_u32 right)
{
    if (left == right) return U32_MAX_VALUE;
    if (left > right) {
        pl_u32 swap = left;
        left = right;
        right = swap;
    }
    return range_u32(
        lcp, size, tree, blocks, left + 1u, right + 1u);
}

static void prior_lcp_side(
    pl_u32 size, const artifact_factor_index_workspace *workspace,
    const pl_u32 *lcp, const pl_u32 *lcp_tree, pl_u32 blocks,
    int successor,
    pl_u32 *answer)
{
    /* Nearest smaller text coordinates on both sides in suffix order are the
     * complete prior-candidate set. A single monotone stack yields one side;
     * the already built LCP tree answers it immediately, so no N-wide
     * candidate/link/head materialization survives. */
    /* The scan consumes SA from left to right, so the already-consumed prefix
     * is the exact stack storage. ISA reconstructs SA after each side. This
     * keeps the LCP column live for boundary-block queries without adding a
     * fifth N-column. */
    pl_u32 *stack = workspace->suffix_array;
    pl_u32 top = 0u;
    for (pl_u32 order = 0u; order < size; ++order) {
        pl_u32 coordinate = workspace->suffix_array[order];
        while (top && stack[top - 1u] > coordinate) {
            pl_u32 removed = stack[--top];
            pl_u32 candidate = successor ? coordinate
                : top ? stack[top - 1u] : U32_MAX_VALUE;
            if (candidate != U32_MAX_VALUE) {
                pl_u32 common = lcp_between(
                    lcp, size, lcp_tree, blocks,
                    workspace->rank[removed], workspace->rank[candidate]);
                if (common > answer[removed]) answer[removed] = common;
            }
        }
        stack[top++] = coordinate;
    }
    while (top) {
        pl_u32 removed = stack[--top];
        pl_u32 candidate = successor ? U32_MAX_VALUE
            : top ? stack[top - 1u] : U32_MAX_VALUE;
        if (candidate != U32_MAX_VALUE) {
            pl_u32 common = lcp_between(
                lcp, size, lcp_tree, blocks,
                workspace->rank[removed], workspace->rank[candidate]);
            if (common > answer[removed]) answer[removed] = common;
        }
    }
}

static void longest_prior_factors(
    const artifact_byte_view *bytes, pl_u32 size, pl_u32 blocks,
    const artifact_factor_index_workspace *workspace)
{
    pl_u32 *tree = (pl_u32 *)(void *)workspace->cost_tree;
    lcp_build(bytes, size, tree, workspace, workspace->source);
    minimum_tree_build(
        workspace->source, size, tree, blocks);
    for (pl_u32 target = 0u; target < size; ++target)
        workspace->length[target] = 0u;
    prior_lcp_side(
        size, workspace, workspace->source,
        tree, blocks, 0, workspace->length);
    for (pl_u32 coordinate = 0u; coordinate < size; ++coordinate)
        workspace->suffix_array[workspace->rank[coordinate]] = coordinate;
    prior_lcp_side(
        size, workspace, workspace->source,
        tree, blocks, 1, workspace->length);
    for (pl_u32 coordinate = 0u; coordinate < size; ++coordinate)
        workspace->suffix_array[workspace->rank[coordinate]] = coordinate;
}

static pl_u32 suffix_cost_at(
    pl_u32 size, const pl_u32 *choice, const pl_u32 *tail, pl_u32 position)
{
    if (position >= size) return 0u;
    pl_u32 block = position / LCP_BLOCK;
    pl_u32 end = (block + 1u) * LCP_BLOCK;
    if (end > size) end = size;
    pl_u32 cost = tail[block];
    for (pl_u32 at = end; at-- > position;)
        cost += choice[at] >> CHOICE_COST_SHIFT;
    return cost;
}

static int dynamic_program(pl_u32 size, pl_u32 width,
                           const artifact_factor_index_workspace *workspace,
                           pl_u64 *retained_bits)
{
    /* Suffix costs are monotone: cost[i] >= cost[i + 1].  Removing the first
     * literal leaves the latter suffix.  Removing the first byte of a prior
     * reference gives a valid reference at i + 1 with the same token cost
     * (or just its tail when the reference length is one).  Therefore the
     * minimum tail in [i + 1, i + LPF[i]] is exactly its right endpoint; a
     * range-minimum tree and N point updates are redundant. */
    if (!retained_bits) return ARTIFACT_ERROR_FACTOR_RANGE;
    pl_u32 *tail = (pl_u32 *)(void *)workspace->cost_tree;
    pl_u32 reference_bits = 1u + width * 2u;
    pl_u32 next = 0u;
    for (pl_u32 target = size; target-- > 0u;) {
        pl_u32 block = target / LCP_BLOCK;
        pl_u32 within = target % LCP_BLOCK;
        pl_u32 block_end = (block + 1u) * LCP_BLOCK;
        if (block_end > size) block_end = size;
        if (target + 1u == block_end) tail[block] = next;
        if (next > U32_MAX_VALUE - 9u)
            return ARTIFACT_ERROR_FACTOR_RANGE;
        pl_u32 best = next + 9u;
        pl_u32 maximum = workspace->length[target];
        pl_u32 selected = 0u;
        if (maximum) {
            pl_u32 position = target + maximum;
            pl_u32 tail_cost = suffix_cost_at(
                size, workspace->length, tail, position);
            if (tail_cost <= U32_MAX_VALUE - reference_bits
                    && tail_cost + reference_bits < best) {
                best = tail_cost + reference_bits;
                /* Equal suffix costs form one plateau. Select its first
                 * coordinate now, while this target's LPF cell is still live,
                 * then replace that LPF by the final choice. */
                pl_u32 low = target + 1u, high = position;
                while (low < high) {
                    pl_u32 middle = low + (high - low) / 2u;
                    pl_u32 middle_cost = suffix_cost_at(
                        size, workspace->length, tail, middle);
                    if (middle_cost == tail_cost) high = middle;
                    else low = middle + 1u;
                }
                selected = low - target;
            }
        }
        if (best < next) return ARTIFACT_ERROR_FACTOR;
        pl_u32 difference = best - next;
        if (difference > 9u) return ARTIFACT_ERROR_FACTOR;
        (void)within;
        workspace->length[target] = selected
            | (difference << CHOICE_COST_SHIFT);
        next = best;
    }
    *retained_bits = next;
    return 0;
}

static int canonical_sources(
    const artifact_byte_view *bytes, pl_u32 size, pl_u32 blocks,
    const artifact_factor_index_workspace *workspace)
{
    pl_u32 *minimum_tree = (pl_u32 *)workspace->cost_tree;
    pl_u32 first_byte[256];
    for (pl_u32 byte = 0u; byte < 256u; ++byte)
        first_byte[byte] = U32_MAX_VALUE;
    pl_u32 coordinate = 0u;
    for (pl_u32 span = 0u; span < bytes->spans; ++span) {
        pl_u32 owner = payload_owner(bytes, span);
        const artifact_payload *payload = &bytes->payload[owner];
        for (pl_u32 index = 0u; index < payload->length;
                ++index, ++coordinate) {
            pl_u8 byte = payload->bytes[index];
            if (first_byte[byte] == U32_MAX_VALUE)
                first_byte[byte] = coordinate;
        }
    }

    /* LPF selection left its sole LCP spelling live in `source`; the packed
     * DP does not touch that column. Rebuild only the small RMQ index. A
     * second N-write LCP pass would retain no new observation. */
    minimum_tree_build(
        workspace->source, size, minimum_tree, blocks);
    for (pl_u32 target = 0u; target < size;) {
        pl_u32 length = workspace->length[target] & CHOICE_LENGTH_MASK;
        workspace->length[target] = length;
        if (!length) {
            ++target;
            continue;
        }
        if (length == 1u) {
            ++target;
            continue;
        }
        pl_u32 order = workspace->rank[target];
        pl_u32 low = 0u, high = order;
        while (low < high) {
            pl_u32 middle = low + (high - low) / 2u;
            if (lcp_between(
                    workspace->source, size,
                    minimum_tree, blocks, middle, order) >= length)
                high = middle;
            else
                low = middle + 1u;
        }
        /* ISA is dead at a selected token once its order has been consumed.
         * The following coordinate is inside this reference, so it cannot be
         * a later token start. Keep the sparse interval in those two dead
         * coordinates while the aliased source/LCP column remains read-only. */
        workspace->rank[target] = low;

        low = order + 1u;
        high = size + 1u;
        while (low < high) {
            pl_u32 middle = low + (high - low) / 2u;
            pl_u32 candidate = middle - 1u;
            if (lcp_between(
                    workspace->source, size,
                    minimum_tree, blocks, order, candidate) >= length)
                low = middle + 1u;
            else
                high = middle;
        }
        /* target+1 is inside this reference and therefore never a token
         * start. It is the exact sparse slot for the exclusive right rank;
         * a dense second interval column is unnecessary. */
        workspace->rank[target + 1u] = low - 1u;
        target += length;
    }

    /* LCP and every remaining ISA coordinate are dead. Rebuild the same
     * block-min arena over SA coordinates; no dense source tree or decoded
     * source column is ever materialized. */
    minimum_tree_build(
        workspace->suffix_array, size, minimum_tree, blocks);

    for (pl_u32 target = 0u; target < size;) {
        pl_u32 length = workspace->length[target];
        if (!length) {
            ++target;
            continue;
        }
        if (length == 1u) {
            pl_u32 source = first_byte[artifact_byte_view_at(bytes, target)];
            if (source >= target) return ARTIFACT_ERROR_FACTOR;
            workspace->source[target] = source;
            ++target;
            continue;
        }
        pl_u32 first = workspace->rank[target];
        pl_u32 last = workspace->rank[target + 1u];
        if (first >= last || last > size)
            return ARTIFACT_ERROR_FACTOR;
        pl_u32 source = range_u32(
            workspace->suffix_array, size,
            minimum_tree, blocks, first, last);
        if (source >= target) return ARTIFACT_ERROR_FACTOR;
        workspace->source[target] = source;
        target += length;
    }
    return 0;
}

int artifact_factor_index_project(
    const artifact_byte_view *bytes,
    const artifact_factor_index_workspace *workspace,
    artifact_factor_projection *out)
{
    if (artifact_byte_view_validate(bytes) || bytes->bytes > 0xffffffffu
            || !out)
        return ARTIFACT_ERROR_FACTOR_RANGE;
    pl_u32 byte_count = (pl_u32)bytes->bytes;
    if (!workspace_valid(workspace, byte_count))
        return ARTIFACT_ERROR_FACTOR_RANGE;
    pl_u32 blocks = 0u, tree = 0u;
    if (!tree_extent(byte_count, &blocks, &tree)
            || tree > workspace->tree_capacity)
        return ARTIFACT_ERROR_FACTOR_RANGE;
    int status = suffix_array_build(bytes, byte_count, workspace);
    if (status) return status;
    longest_prior_factors(bytes, byte_count, blocks, workspace);
    pl_u32 width = bit_width(byte_count);
    pl_u64 retained_bits = 0u;
    status = dynamic_program(byte_count, width, workspace, &retained_bits);
    if (status) return status;
    status = canonical_sources(bytes, byte_count, blocks, workspace);
    if (status) return status;

    pl_u32 tokens = 0u, literals = 0u, references = 0u;
    pl_u64 literal_bytes = 0u, referenced_bytes = 0u;
    for (pl_u32 at = 0u; at < byte_count;) {
        ++tokens;
        pl_u32 length = workspace->length[at];
        if (!length) {
            ++literals;
            ++literal_bytes;
            ++at;
        } else {
            if (length > byte_count - at || workspace->source[at] >= at)
                return ARTIFACT_ERROR_FACTOR;
            ++references;
            referenced_bytes += length;
            at += length;
        }
    }
    *out = (artifact_factor_projection){
        byte_count, width, tokens, literals, references,
        literal_bytes, referenced_bytes, (pl_u64)byte_count * 9u,
        retained_bits, 0u,
    };
    return 0;
}

int artifact_factor_index_decode(
    const artifact_byte_view *bytes,
    const artifact_factor_index_workspace *workspace,
    pl_u8 *target, pl_u32 target_capacity)
{
    if (artifact_byte_view_validate(bytes) || bytes->bytes > 0xffffffffu
            || !workspace || !workspace->source || !workspace->length
            || !target || target_capacity < bytes->bytes)
        return ARTIFACT_ERROR_FACTOR_RANGE;
    pl_u32 byte_count = (pl_u32)bytes->bytes;
    for (pl_u32 at = 0u; at < byte_count;) {
        pl_u32 length = workspace->length[at];
        if (!length) {
            target[at] = artifact_byte_view_at(bytes, at);
            ++at;
        } else {
            pl_u32 source = workspace->source[at];
            if (source >= at || length > byte_count - at)
                return ARTIFACT_ERROR_FACTOR;
            for (pl_u32 index = 0u; index < length; ++index)
                target[at + index] = target[source + index];
            at += length;
        }
    }
    return 0;
}

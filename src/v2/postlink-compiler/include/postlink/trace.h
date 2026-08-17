/* Fusible traces over the block graph.
 *
 * A dispatch disappears entirely when a block's successor is the only place
 * control can reach that successor from: the two blocks then always run as one,
 * so their operator graphs can be composed and the boundary between them stops
 * existing.  That is what makes a multi-block loop body eligible for the
 * recurrence closure, whose recognizer today insists the body be a single block
 * and therefore matches almost nothing.
 *
 * This computes the graph the fusion engine needs -- unique successor and
 * predecessor multiplicity per block -- from the descriptor region alone.  No
 * SSA is read and no template is touched, so it is cheap enough to run over
 * every block and honest about what it does and does not prove: it finds where
 * fusion is *structurally* legal, not where it is profitable, and not that one
 * iteration's effect is affine in the induction variable.
 */

#ifndef POSTLINK_TRACE_H
#define POSTLINK_TRACE_H

#include <postlink/chain.h>

#define PL_NO_BLOCK 0xffffffffu

/* Predecessor counts saturate: fusion only ever asks "exactly one?", so
 * counting past two would be wasted work over 279,371 edges. */
#define PL_PRED_NONE 0u
#define PL_PRED_ONE  1u
#define PL_PRED_MANY 2u

/* Fill, for every block index:
 *
 *   successor[i]         the unique static successor's row, or PL_NO_BLOCK when
 *                        the block has no successor, several, an unresolvable
 *                        one, or one whose coordinate carries proof variants
 *   predecessor[i]       PL_PRED_NONE / ONE / MANY, counting only the edges
 *                        that successor[] records
 *
 * `successor` and `predecessor` must each hold block_count entries.  Returns 0,
 * or the first admission error encountered.
 */
int pl_trace_edges(const pl_directory *directory,
                   pl_u32 *successor, pl_u8 *predecessor);

/* True when `index` and its successor always run together, so the boundary
 * between them can be composed away. */
static inline int pl_trace_fusible(const pl_u32 *successor,
                                   const pl_u8 *predecessor, pl_u32 index)
{
    pl_u32 next = successor[index];
    return next != PL_NO_BLOCK && predecessor[next] == PL_PRED_ONE;
}

/* Walk the maximal fusible run starting at `index`, following successors while
 * each step stays fusible and no row repeats.  Returns the number of blocks in
 * the run, at least one, and reports the last row.  `visited` marks rows the
 * walk consumed so a caller enumerating every run does not count a row twice;
 * pass 0 to walk without marking. */
pl_u32 pl_trace_run(const pl_u32 *successor, const pl_u8 *predecessor,
                    pl_u32 block_count, pl_u32 index, pl_u8 *visited,
                    pl_u32 *last);

#endif /* POSTLINK_TRACE_H */

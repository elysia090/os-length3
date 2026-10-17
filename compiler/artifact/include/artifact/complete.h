/* One necessary-and-sufficient complete-sharing publication gate. */

#ifndef ARTIFACT_COMPLETE_H
#define ARTIFACT_COMPLETE_H

#include <artifact/archive.h>
#include <artifact/derive.h>
#include <artifact/factor-codec.h>
#include <artifact/factor-index.h>
#include <artifact/future.h>
#include <artifact/namespace.h>
#include <artifact/payload.h>
#include <artifact/program.h>
#include <artifact/rank-map.h>

#define ARTIFACT_ERROR_COMPLETE       (-79)
#define ARTIFACT_ERROR_COMPLETE_RANGE (-80)
#define ARTIFACT_SEMANTIC_FAMILIES     6u

typedef struct {
    /* Exact typed populations declared independently by the enclosing
     * closure proof.  A set bit says that the family's total generator and
     * closure count were checked; that count may correctly be zero.  A
     * cleared bit requires zero occurrences. Keeping one row while silently
     * dropping another row of the same family is not complete.  The rows are
     * derived directly from the authorities below; a second flattened
     * semantic population is intentionally absent. */
    pl_u32 required_semantic_family_mask;
    pl_u32 required_semantic_occurrences[ARTIFACT_SEMANTIC_FAMILIES];

    /* Authoritative compiler population for every block, normalized slice,
     * lifted-parameter instance and source-instruction witness across the
     * disjoint union of linked ELFs. Caller-supplied ranks or flattened
     * observation rows cannot stand in for this graph. */
    const artifact_program_population *program;
    pl_u32 required_program_instruction_classes;
    pl_u32 required_program_future_classes;

    /* Every canonical immutable extent, independent of its ELF/archive/VFS
     * container. Exact duplicate owners disappear before substring search.
     * The required count comes from the release-root closure, not this array. */
    const artifact_payload *payloads;
    pl_u32 payload_occurrences;
    pl_u32 required_payload_occurrences;
    /* Exact payload quotient produced once by the enclosing transaction.
     * Rehashing the same N bytes inside this gate would be a second route. */
    const artifact_payload_projection *payload_projection;

    /* Archives are views over the same global payload population above.
     * Counts come from the release closure walk, not from the supplied views.
     * A successful projection regenerates every canonical archive byte; no
     * serialized member stream remains as a second payload owner. */
    const artifact_archive_instance *archives;
    pl_u32 archive_count;
    pl_u32 required_archive_count;
    pl_u32 required_archive_members;
    pl_u32 required_archive_symbols;
    /* Archive public responses combine view metadata with member bytes and
     * therefore need one small cross-archive quotient.  This is the only
     * typed row population not already owned by another projection. */
    const artifact_complete_observation *archive_semantic;
    pl_u32 archive_semantic_occurrences;
    /* Member payload occurrences are one contiguous flattened interval.
     * member i resolves as archive_member_payload_base + i; no N-element
     * member-to-payload column may be retained. */
    pl_u32 archive_member_payload_base;

    /* Canonical release tree. Its basenames, ordered-tree topology, inode
     * metadata and sparse aliases must already be occurrences in `payloads`,
     * so namespace bytes share the same global Byte* owner as code, rodata,
     * program meanings and archive views. */
    /* The POSIX source walk has already disappeared. Publication consumes
     * only the source-free canonical stream; accepting construction rows here
     * would materialize the namespace a second time. */
    const artifact_namespace_projection *namespace_projection;
    pl_u32 required_namespace_paths;
    pl_u32 required_namespace_inodes;

    /* Proof, coordinate and directory cells opened against one already
     * selected total generator. The required count fixes its total domain. */
    const artifact_cell *actual_cells;
    const artifact_cell *generated_cells;
    pl_u32 cell_coordinates;
    pl_u32 required_cell_coordinates;
} artifact_complete_population;

typedef struct {
    artifact_program_workspace program;
    artifact_rank_map_workspace block_future_rank;
    artifact_payload_workspace payload;
    artifact_rank_map_workspace payload_rank;
    artifact_share_workspace archive_semantic;
    artifact_archive_complete_workspace archive;
    artifact_namespace_workspace namespace_workspace;
    artifact_derive_workspace derived;
    artifact_factor_index_workspace factor;
    pl_u8 *factor_code;
    pl_u32 factor_code_capacity;
    pl_u64 *payload_end;
    pl_u32 payload_end_capacity;
} artifact_complete_workspace;

typedef struct {
    pl_u32 occurrences;
    pl_u32 classes;
    /* Global rank is a fixed family/domain class offset plus the already
     * proved local rank.  No dense all-family rank column is retained. */
    pl_u32 generated_rank_cells;
    pl_u32 retained_rank_cells;
} artifact_semantic_projection;

typedef struct {
    artifact_semantic_projection semantic;
    artifact_program_projection program;
    artifact_future_projection block_future;
    artifact_rank_map_projection block_future_rank;
    artifact_payload_projection payload;
    artifact_rank_map_projection payload_rank;
    artifact_archive_complete_projection archive;
    artifact_namespace_projection namespace_projection;
    artifact_derive_projection derived;
    artifact_factor_projection factor;
    artifact_factor_code_projection factor_code;
    pl_u32 semantic_family_mask;
    pl_u32 semantic_family_occurrences[ARTIFACT_SEMANTIC_FAMILIES];
    pl_u32 canonical_byte_extent;
} artifact_complete_projection;

/* Run the complete composition in its only legal order:
 *
 *   canonical instructions  -> one complete-future program rank
 *   typed authorities        -> family/domain offset + local semantic rank
 *   emitted immutable bytes -> exact payload owner -> one virtual Byte* view
 *   archive view             -> regenerate exact stream from payload ranks
 *   generated cell          -> exact exception residual
 *   virtual Byte* view      -> exact shortest prior-factor spelling
 *   selected factors        -> stored bits -> source-free direct verification
 *
 * The routine reopens every local rank, cell and byte. The global semantic
 * rank is generated by disjoint family/domain offsets instead of flattening
 * and hashing the same observations again. A successful result has no dense
 * rank table, digest-only equality, container-local owner, retained generated
 * cell or unresolved factor gap. Supplying a total generator is a
 * precondition; choosing the least fully charged generator remains a separate
 * build gate. */
int artifact_complete_project(
    const artifact_complete_population *population,
    const artifact_complete_workspace *workspace,
    artifact_complete_projection *out);

/* The same gate has one explicit lifetime cut. `prepare` proves every typed
 * authority and binds the canonical virtual Byte*; no factor selection has
 * happened yet. The caller may then retain only that borrowed view and free
 * all semantic construction scratch. `factor` proves the unique stored
 * spelling and completes the projection. `artifact_complete_project` is the
 * no-cut convenience composition of these two operations. */
int artifact_complete_prepare(
    const artifact_complete_population *population,
    const artifact_complete_workspace *workspace,
    artifact_byte_view *canonical,
    artifact_complete_projection *out);

int artifact_complete_factor(
    const artifact_byte_view *canonical,
    const artifact_factor_index_workspace *workspace,
    pl_u8 *factor_code, pl_u32 factor_code_capacity,
    artifact_complete_projection *in_out);

#endif /* ARTIFACT_COMPLETE_H */

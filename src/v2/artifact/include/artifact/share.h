/* Exact typed quotient for complete finite observations. */

#ifndef ARTIFACT_SHARE_H
#define ARTIFACT_SHARE_H

#include <support/sha256.h>

#define ARTIFACT_ERROR_SHARE       (-65)
#define ARTIFACT_ERROR_SHARE_RANGE (-66)
#define ARTIFACT_ERROR_SHARE_RANK  (-67)

enum artifact_observation_family {
    ARTIFACT_OBSERVATION_BLOCK = 1u,
    ARTIFACT_OBSERVATION_SLICE = 2u,
    ARTIFACT_OBSERVATION_INSTRUCTION = 3u,
    ARTIFACT_OBSERVATION_IMMUTABLE_READ = 4u,
    ARTIFACT_OBSERVATION_ARCHIVE_MEMBER = 5u,
    ARTIFACT_OBSERVATION_DERIVED_CELL = 6u,
    /* The one intentionally untyped class after semantic canonicalization.
     * ELF, rodata, archive and proof extents enter this family so identical
     * immutable bytes have one owner across every enclosing format. */
    ARTIFACT_OBSERVATION_PAYLOAD = 7u,
};

/* `domain` is the complete accepted request domain and `response` is the
 * corresponding total canonical response word.  Neither field may contain
 * provenance, address, path, discovery order or delivery placement.  Two
 * observations are substitutable exactly when all five fields below are
 * byte-identical. */
typedef struct {
    pl_u32 family;
    const pl_u8 *domain;
    pl_u32 domain_bytes;
    const pl_u8 *response;
    pl_u32 response_bytes;
} artifact_complete_observation;

typedef struct {
    pl_u8 *digest;
    pl_u32 digest_bytes;
    pl_u32 *order;
    pl_u32 *temporary;
    pl_u32 *rank;
    pl_u32 *representative;
    pl_u32 capacity;
} artifact_share_workspace;

typedef struct {
    pl_u32 occurrences;
    pl_u32 classes;
    pl_u64 opened_observation_bytes;
    pl_u64 retained_observation_bytes;
    /* Construction result only.  An enclosing finite-function projection
     * must still prove whether each use-site rank is generated or residual. */
    pl_u64 projected_rank_cells;
} artifact_share_projection;

int artifact_share_measure(pl_u32 occurrences, pl_u32 *digest_bytes,
                           pl_u32 *index_capacity);

/* Ranks are canonical under permutation of the occurrence population.  The
 * digest only accelerates ordering.  Equal-digest observations are compared
 * in full, so digest collision never establishes identity. */
int artifact_share_project(
    const artifact_complete_observation *observations, pl_u32 occurrences,
    const artifact_share_workspace *workspace,
    artifact_share_projection *out);

/* Reconstruct the canonical quotient and reject both failure directions:
 * equal observations assigned different ranks and unequal observations
 * assigned one rank.  Rank renaming is also rejected because rank order is
 * part of the canonical spelling. */
int artifact_share_verify(
    const artifact_complete_observation *observations, pl_u32 occurrences,
    const pl_u32 *claimed_rank, pl_u32 claimed_classes,
    const artifact_share_workspace *workspace,
    artifact_share_projection *out);

/* Find one exact observation after `artifact_share_project`. The canonical
 * digest+observation order is searched in O(log N); the digest is only the
 * primary key and full bytes still decide equality. */
int artifact_share_find(
    const artifact_complete_observation *observations, pl_u32 occurrences,
    const artifact_share_workspace *workspace,
    const artifact_complete_observation *needle, pl_u32 *rank);

#endif /* ARTIFACT_SHARE_H */

/* Exact reconstruction of ordinary optimized ELF images from shared spans. */

#ifndef ARTIFACT_EXECUTABLE_H
#define ARTIFACT_EXECUTABLE_H

#include <artifact/derive.h>
#include <artifact/payload.h>

#define ARTIFACT_ERROR_EXECUTABLE       (-87)
#define ARTIFACT_ERROR_EXECUTABLE_RANGE (-88)

typedef struct {
    const artifact_cell *image;          /* images */
    const pl_u32 *state_offset;          /* images + 1 */
    const artifact_cell *emitted;        /* states; empty is permitted */
    const pl_u64 *emitted_file_offset;   /* states */
    pl_u32 images;
    pl_u32 states;
} artifact_executable_population;

typedef struct {
    artifact_payload *fragment;          /* measured nonempty extents */
    pl_u32 fragment_capacity;
    pl_u32 *image_fragment_offset;       /* images + 1 */
    pl_u32 image_fragment_capacity;
    artifact_payload_workspace payload;
} artifact_executable_workspace;

typedef struct {
    artifact_payload_projection fragment;
    pl_u32 images;
    pl_u32 states;
    pl_u32 fragment_occurrences;
    pl_u32 nonempty_emitted_states;
    pl_u32 generated_file_coordinates;
    pl_u64 opened_image_bytes;
    pl_u64 emitted_bytes;
    pl_u64 gap_bytes;
    pl_u64 reconstructed_bytes;
} artifact_executable_projection;

/* Exact metadata pass: empty states and empty prefix/suffix gaps contribute
 * no payload descriptor. Does not allocate or copy executable bytes. */
int artifact_executable_measure(
    const artifact_executable_population *population, pl_u32 *fragments);

/* Each image's emitted state spans must be a contiguous file interval in the
 * compiler's dense state order.  Prefix, nonempty state spans and suffix form
 * the sole payload occurrence sequence.  Exact payload ranks then rebuild
 * every ordinary ELF byte; per-state file offsets are generated prefix sums.
 * Reconstruction compares the selected spans directly against the image;
 * neither a dense state-to-fragment map nor a copied image is required. */
int artifact_executable_project(
    const artifact_executable_population *population,
    const artifact_executable_workspace *workspace,
    artifact_executable_projection *out);

#endif /* ARTIFACT_EXECUTABLE_H */

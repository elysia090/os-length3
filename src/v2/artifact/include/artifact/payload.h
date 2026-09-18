/* One exact immutable-payload owner across every canonical container. */

#ifndef ARTIFACT_PAYLOAD_H
#define ARTIFACT_PAYLOAD_H

#include <artifact/share.h>

#define ARTIFACT_ERROR_PAYLOAD       (-75)
#define ARTIFACT_ERROR_PAYLOAD_RANGE (-76)

typedef struct {
    const pl_u8 *bytes;
    pl_u32 length;
} artifact_payload;

typedef struct {
    artifact_complete_observation *observation;
    pl_u32 observation_capacity;
    artifact_share_workspace share;
} artifact_payload_workspace;

typedef struct {
    pl_u32 occurrences;
    pl_u32 classes;
    pl_u64 opened_bytes;
    pl_u64 unique_bytes;
    pl_u64 duplicate_bytes_eliminated;
} artifact_payload_projection;

/* A canonical Byte* without a second byte owner.  `end` is the strict CSR
 * endpoint of each unique payload class and `representative` selects the
 * original immutable extent. After owners are compacted into class order,
 * `representative == NULL` is the canonical identity projection and
 * `payload_occurrences == spans`. Concatenation is therefore a coordinate
 * law, never an opened N-byte allocation. */
typedef struct {
    const artifact_payload *payload;
    pl_u32 payload_occurrences;
    const pl_u32 *representative;
    const pl_u64 *end;
    pl_u32 spans;
    pl_u64 bytes;
} artifact_byte_view;

/* `share` is measured by artifact_share_measure(occurrences).  The additional
 * observation workspace contains one construction-only descriptor per input
 * extent; no descriptor is part of the published word. */
int artifact_payload_project(
    const artifact_payload *payloads, pl_u32 occurrences,
    const artifact_payload_workspace *workspace,
    artifact_payload_projection *out);

/* Bind every representative exactly once in canonical class order.  Only the
 * strict CSR endpoint column is opened; payload bytes remain at their one
 * immutable owner. */
int artifact_payload_view(
    const artifact_payload *payloads, pl_u32 occurrences,
    const artifact_payload_workspace *workspace,
    const artifact_payload_projection *projection,
    pl_u64 *end, pl_u32 end_capacity,
    artifact_byte_view *out);

int artifact_byte_view_validate(const artifact_byte_view *view);

/* Coordinate access is a predecessor query over strict CSR endpoints.  It is
 * intentionally header-inline because suffix construction performs this on
 * its hot random-access path. */
static inline pl_u8 artifact_byte_view_at(
    const artifact_byte_view *view, pl_u32 coordinate)
{
    pl_u32 low = 0u, high = view->spans;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        if ((pl_u64)coordinate < view->end[middle]) high = middle;
        else low = middle + 1u;
    }
    pl_u64 first = low ? view->end[low - 1u] : 0u;
    pl_u32 owner = view->representative ? view->representative[low] : low;
    return view->payload[owner].bytes[(pl_u64)coordinate - first];
}

/* Compare two intervals without opening either one. */
int artifact_byte_view_equal(
    const artifact_byte_view *view,
    pl_u32 left, pl_u32 right, pl_u32 bytes);

pl_u32 artifact_byte_view_common_prefix(
    const artifact_byte_view *view,
    pl_u32 left, pl_u32 right, pl_u32 limit);

/* Resolve a required immutable extent through the already-built global
 * payload quotient. This is the binding used by semantic program material,
 * archive views and residual exceptions; it never scans all payloads. */
int artifact_payload_find(
    const artifact_payload *payloads, pl_u32 occurrences,
    const artifact_payload_workspace *workspace,
    const pl_u8 *bytes, pl_u32 length, pl_u32 *rank);

#endif /* ARTIFACT_PAYLOAD_H */

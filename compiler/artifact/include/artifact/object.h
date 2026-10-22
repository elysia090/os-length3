/* Canonical immutable object identity, independent of every locator/codec. */

#ifndef ARTIFACT_OBJECT_H
#define ARTIFACT_OBJECT_H

#include <support/sha256.h>

typedef struct {
    pl_u8 digest[PL_SHA256_BYTES];
    pl_u64 bytes;
    pl_u32 kind;
    pl_u32 version;
} artifact_object;

int artifact_object_validate(const artifact_object *object);
int artifact_object_matches(const artifact_object *object,
                            const pl_u8 *bytes, pl_u64 length);

#endif /* ARTIFACT_OBJECT_H */
